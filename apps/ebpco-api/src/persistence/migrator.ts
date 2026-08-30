import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SqlClient } from './sql-client';

/**
 * Forward-only, versioned, checksummed migrations.
 *
 * Three properties, each answering a way schema management goes wrong:
 *
 * **Forward-only.** There are no `down` scripts. A down migration is a promise
 * that a rollback will be tested, and it almost never is; worse, it invites a
 * release that drops a column, which cannot be rolled back at all once a row is
 * gone. The safe path is expand → migrate → contract, where every intermediate
 * state is one the previous release can still run against, and the rollback is
 * redeploying the previous image.
 *
 * **Checksummed.** An applied migration's content is recorded. Editing a file
 * that has already run is refused, because it produces two databases with the
 * same version number and different shapes -- and the one that is wrong is
 * always production.
 *
 * **Transactional per migration.** PostgreSQL has transactional DDL. A migration
 * that fails halfway leaves nothing behind, so the next attempt starts from a
 * known state rather than from a partially-applied one.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export class MigrationError extends Error {}

const LEDGER = `
  create table if not exists schema_migrations (
    version     integer primary key,
    name        text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now()
  );
`;

export function loadMigrations(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations = files.map((file) => {
    const match = /^(\d+)[_-](.+)\.sql$/.exec(file);
    if (match === null) {
      throw new MigrationError(`migration filename must be NNN_name.sql, got ${file}`);
    }
    return {
      version: Number(match[1]),
      name: match[2] ?? file,
      sql: readFileSync(join(directory, file), 'utf8'),
    };
  });

  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      // Two migrations claiming one version is how two developers' work
      // silently overwrites each other.
      throw new MigrationError(`duplicate migration version ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations.sort((a, b) => a.version - b.version);
}

export function checksum(sql: string): string {
  // Whitespace-insensitive, so reindenting a migration is not a false alarm,
  // but any change to a statement is.
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
}

export async function applied(client: SqlClient): Promise<AppliedMigration[]> {
  await client.exec(LEDGER);
  const result = await client.query<{ version: number; name: string; checksum: string; applied_at: Date }>(
    'select version, name, checksum, applied_at from schema_migrations order by version',
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[],
  onApplied: (migration: Migration) => void = () => undefined,
): Promise<{ applied: number; alreadyCurrent: number }> {
  const history = await applied(client);
  const byVersion = new Map(history.map((entry) => [entry.version, entry]));

  // Verify history before applying anything: a tampered migration must stop the
  // deploy, not be discovered halfway through a partially-migrated schema.
  for (const migration of migrations) {
    const previous = byVersion.get(migration.version);
    if (previous === undefined) continue;
    if (previous.checksum !== checksum(migration.sql)) {
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) has changed since it was applied. ` +
          'An applied migration is immutable: write a new one. Editing this file would produce ' +
          'two databases with the same version and different shapes.',
      );
    }
  }

  // An applied version with no file is a deploy going backwards -- the database
  // is ahead of the code, which means someone is rolling back into a schema the
  // old code has never seen.
  const known = new Set(migrations.map((migration) => migration.version));
  for (const entry of history) {
    if (!known.has(entry.version)) {
      throw new MigrationError(
        `the database has migration ${entry.version} (${entry.name}) which this build does not contain. ` +
          'This build is older than the schema it is being deployed against.',
      );
    }
  }

  let count = 0;
  for (const migration of migrations) {
    if (byVersion.has(migration.version)) continue;

    // PostgreSQL has transactional DDL, so a migration that fails halfway
    // leaves nothing behind.
    await client.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query(
        'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [migration.version, migration.name, checksum(migration.sql)],
      );
    });
    onApplied(migration);
    count += 1;
  }

  return { applied: count, alreadyCurrent: history.length };
}
