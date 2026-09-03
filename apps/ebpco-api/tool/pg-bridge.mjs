/**
 * A local PostgreSQL, over the wire, without installing PostgreSQL.
 *
 * This existed for weeks in a scratch directory and was NOT in the repository,
 * while `docs/LOCAL-INSTANCE.md` step 1 told the reader to run it. It worked
 * every time for the person who had written it and could not work for anybody
 * else — the admin portal lane hit exactly that and had to reconstruct it. A
 * runbook whose first step names a file nobody has is worse than no runbook,
 * because it costs an afternoon before it is disbelieved.
 *
 *   PGDATA_DIR=/tmp/ebpco-pg node tool/pg-bridge.mjs
 *
 * DEVELOPMENT ONLY. It serves ONE CONNECTION AT A TIME — see the notes in the
 * runbook about `DB_POOL_MAX=1` and about stopping the API before seeding.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * Where the data lives, and why there is no default.
 *
 * Without a directory PGlite opens an EMPTY IN-MEMORY database. That does not
 * fail: it comes up, answers queries, and has nothing in it — which on a second
 * run looks exactly like total data loss. Refusing to start is the only honest
 * behaviour, because the alternative is indistinguishable from a catastrophe.
 */
const dataDir = process.env.PGDATA_DIR;
if (dataDir === undefined || dataDir.trim() === '') {
  process.stderr.write(
    'PGDATA_DIR is required. Without it PGlite opens an empty in-memory database, '
    + 'which on the next restart is indistinguishable from total data loss.\n'
    + 'Try: PGDATA_DIR=/tmp/ebpco-pg node tool/pg-bridge.mjs\n',
  );
  process.exit(1);
}

// 5433, not 5432. A real PostgreSQL — or another agent's bridge — may already
// hold 5432 on a shared machine, and running migrations into somebody else's
// database is destructive in a way that reports success. This must agree with
// `.env.example`; they disagreed once and cost a day.
const port = Number(process.env.PGPORT ?? 5433);

const db = await PGlite.create({ dataDir });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });

try {
  await server.start();
} catch (error) {
  // The likely failure on a shared machine, and worth catching by name: this
  // is a development tool a runbook tells people to run, and a raw node stack
  // trace makes a taken port look like a broken script. It happened on the
  // first honest dry run of that runbook -- another lane's bridge already held
  // 5433.
  if (error?.code === 'EADDRINUSE') {
    process.stderr.write(
      `Port ${port} is already in use on 127.0.0.1.\n`
      + 'Something else is already serving it — another lane\'s bridge, or a real\n'
      + 'PostgreSQL. Do NOT stop it if it is not yours; on a shared machine it is\n'
      + 'somebody\'s database.\n\n'
      + `Use another port instead, and point DATABASE_URL at the same one:\n`
      + `  PGPORT=5434 PGDATA_DIR=${dataDir} node tool/pg-bridge.mjs\n`,
    );
    await db.close();
    process.exit(1);
  }
  throw error;
}
process.stdout.write(`pg bridge listening on 127.0.0.1:${port}, data in ${dataDir}\n`);
process.stdout.write('one connection at a time: stop the API before running a script against it\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.stop().then(() => db.close()).then(() => process.exit(0));
  });
}
