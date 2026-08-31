import { SqlClient } from './sql-client';

/**
 * Runs `work` in one transaction: everything it writes commits together, or
 * none of it does.
 *
 * The dispatch below is not defensive politeness — it is correctness. Issuing
 * `BEGIN` through a connection POOL is actively wrong: the pool is free to run
 * the next statement on a different connection, so the `BEGIN`, the writes and
 * the `COMMIT` can land on three different sessions and the transaction
 * silently means nothing. A pool must be given a dedicated client first.
 */
interface PgliteLike {
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>;
}

interface PoolLike {
  connect(): Promise<SqlClient & { release(): void }>;
}

const hasTransaction = (db: SqlClient): db is SqlClient & PgliteLike =>
  typeof (db as Partial<PgliteLike>).transaction === 'function';

const hasConnect = (db: SqlClient): db is SqlClient & PoolLike =>
  typeof (db as Partial<PoolLike>).connect === 'function';

export async function inTransaction<T>(
  db: SqlClient, work: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  if (hasTransaction(db)) return db.transaction(work);

  if (hasConnect(db)) {
    const client = await db.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  // A single dedicated connection. Safe only because it IS single — which is
  // why the two cases above exist rather than this being the only path.
  await db.query('begin');
  try {
    const result = await work(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
