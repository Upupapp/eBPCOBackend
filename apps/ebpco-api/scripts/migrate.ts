/**
 * Applies pending migrations, then exits.
 *
 * The service deliberately does NOT migrate on boot -- N replicas racing to
 * alter one schema, and a rollback that has to guess what was applied. The
 * design has always said migrations run in the deployment pipeline, BEFORE the
 * new version rolls out. Until 2026-08-30 nothing existed for that pipeline to
 * run, which is one of the three things blocking B-1.
 *
 * ── What it will not do ─────────────────────────────────────────────────
 *
 * It does not roll back, and there is no `down`. A down-migration is a second,
 * far less tested path that runs at the worst possible moment, and it cannot
 * restore data a forward migration dropped. Recovery is a restore plus a fixed
 * forward migration, which is the path that gets exercised.
 *
 * It does not create the database. A pipeline that can create databases can
 * also create one by typo and route production at it.
 *
 * ── Exit codes, because a pipeline reads them ───────────────────────────
 *
 * 0 applied or already current; 1 anything else. Prints every version it
 * applies as it applies it, so a run that dies halfway names the last one that
 * landed rather than leaving an operator to diff the ledger by hand.
 *
 * It does no checking of its own. `migrate` already refuses a migration edited
 * since it was applied, and a database holding a version this build does not
 * contain -- and duplicating either here would give the rule two owners that
 * can disagree. This prints what it says and returns a code.
 */
import { join } from 'node:path';

import { loadConfig } from '../src/config/app-config';
import { PostgresClient } from '../src/persistence/postgres-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const client = PostgresClient.fromUrl(config.DATABASE_URL, {
    // One connection, and a generous statement timeout. A migration that adds
    // an index to a large table legitimately takes minutes, and the service's
    // 30-second statement timeout would abort it halfway.
    max: 1,
    connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: 0,
  });

  // WHICH database, said out loud before anything is applied.
  //
  // Migrating the wrong one is not a loud failure: if something else answers
  // the port with a similar schema, the run succeeds, touches records nobody
  // meant to touch, and reports no error. That is not hypothetical -- an UPDATE
  // against the wrong port matched 0 rows with no clue, and cost a day.
  //
  // Parsed rather than printed raw, because a DATABASE_URL carries a password
  // and this line goes into terminals and CI logs.
  const target = new URL(config.DATABASE_URL);
  process.stdout.write(
    `migrating ${target.hostname}:${target.port || '5432'}${target.pathname} `
    + `(${migrations.length} migration(s) on disk)\n`,
  );

  try {
    const result = await migrate(client, migrations, (migration) => {
      process.stdout.write(`applied ${migration.version} ${migration.name}\n`);
    });

    process.stdout.write(
      result.applied === 0
        ? `already current at ${migrations.length} migration(s)\n`
        : `applied ${result.applied} migration(s); ${result.alreadyCurrent} already current\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
