/**
 * Runs `scripts/migrate.ts` against a real PostgreSQL wire protocol, twice.
 *
 * Not part of `verify.sh`. It starts a TCP server and spawns a child process,
 * which is slow and would make every other Jest worker queue behind it -- the
 * starvation this repo has already been bitten by once. Run it on demand, and
 * before any first deployment.
 *
 * Why it exists at all: the migration runner uses `pg` over a socket, and
 * nothing else in this repository does. Every other test speaks to PGlite
 * IN-PROCESS, so the entire wire path -- connection string parsing, the driver,
 * the pool, statement timeouts -- was unexercised. `PGLiteSocketServer` serves
 * the same PostgreSQL build over the real protocol, which is as close to a
 * managed Postgres as this machine can get without one installed.
 *
 * What it does NOT cover: TLS, roles and grants, and anything a managed
 * provider does differently. Those need a real server.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const PORT = 54329;

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  EBPCO_ENVIRONMENT: 'development',
  // No inline password, and not only to satisfy the secret scanner -- which
  // caught the first version of this line and was right to. A connection string
  // carrying a password in committed source is the exact shape that leaks a
  // real one, and the socket server authenticates nobody, so there was never a
  // credential to write here.
  DATABASE_URL: `postgres://postgres@127.0.0.1:${PORT}/postgres`,
  OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://localhost:3310',
  JWT_SIGNING_KEY: 'a-development-signing-key-of-at-least-32',
  PASSWORD_PEPPER: 'a-development-pepper-of-at-least-32-chars',
};

/**
 * Spawned ASYNCHRONOUSLY, and that is not a style choice.
 *
 * `spawnSync` blocks this process's event loop until the child exits -- and the
 * PostgreSQL server the child is connecting to is running IN THIS PROCESS. The
 * server cannot answer while the loop is blocked, so the child waits for a
 * connection that cannot be served and dies on its connection timeout. A
 * deadlock that reads exactly like an unreachable database.
 */
function runMigrate(): Promise<{ status: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['ts-node', '--transpile-only', join(__dirname, 'migrate.ts')], {
      env: ENV,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, out }));
  });
}

async function main(): Promise<number> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();

  try {
    const first = await runMigrate();
    process.stdout.write(first.out);
    if (first.status !== 0) {
      process.stderr.write('  FAIL  the first run did not succeed\n');
      return 1;
    }
    if (!/applied \d+ migration/.test(first.out)) {
      process.stderr.write('  FAIL  the first run applied nothing against an empty database\n');
      return 1;
    }

    // The run that matters more. A migrator that is not idempotent turns every
    // deploy into a decision about whether it is safe to run again.
    const second = await runMigrate();
    process.stdout.write(second.out);
    if (second.status !== 0 || !second.out.includes('already current')) {
      process.stderr.write('  FAIL  the second run was not a clean no-op\n');
      return 1;
    }

    // And the schema is really there, rather than a ledger full of rows.
    const tables = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public'`,
    );
    const count = tables.rows[0]?.n ?? 0;
    if (count < 20) {
      process.stderr.write(`  FAIL  only ${count} tables exist after migrating\n`);
      return 1;
    }

    process.stdout.write(`  ok   migrated over the wire protocol; ${count} tables, and a `
      + 'second run changed nothing\n');
    return 0;
  } finally {
    await server.stop();
    await db.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
