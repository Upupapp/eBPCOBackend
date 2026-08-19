import type { Pool, PoolClient } from 'pg';

import { PostgresClient } from './postgres-client';

/**
 * The pooled adapter, which PGlite cannot exercise.
 *
 * Every other persistence test runs against PGlite — real PostgreSQL, real
 * constraints, real triggers — and none of it touches this class, because
 * PGlite is not a pool. So the code that every deployment actually runs, and
 * only that code, was untested: connection acquisition, release, and what
 * happens to an error on the way out of a transaction.
 *
 * A fake pool rather than a real server. What is asserted here is this
 * adapter's OWN behaviour — did it release the connection, did it preserve the
 * error — which is a question about this file, not about PostgreSQL. Pooling
 * under real concurrency is a different question and is recorded as unverified.
 */

interface Recorded {
  readonly statements: string[];
  released: number;
  destroyed: number;
  ended: boolean;
}

function fakePool(behaviour: {
  onQuery?: (sql: string) => void;
  connectRejects?: Error;
} = {}): { pool: Pool; recorded: Recorded } {
  const recorded: Recorded = { statements: [], released: 0, destroyed: 0, ended: false };

  const client = {
    query: (sql: string) => {
      recorded.statements.push(sql);
      behaviour.onQuery?.(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => {
      recorded.released += 1;
      if (destroy === true) recorded.destroyed += 1;
    },
  } as unknown as PoolClient;

  const pool = {
    connect: () => (behaviour.connectRejects === undefined
      ? Promise.resolve(client)
      : Promise.reject(behaviour.connectRejects)),
    query: (sql: string) => {
      recorded.statements.push(sql);
      behaviour.onQuery?.(sql);
      return Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 });
    },
    end: () => {
      recorded.ended = true;
      return Promise.resolve();
    },
  } as unknown as Pool;

  return { pool, recorded };
}

describe('a transaction', () => {
  it('commits and releases the connection', async () => {
    const { pool, recorded } = fakePool();

    await new PostgresClient(pool).transaction(async (tx) => {
      await tx.query('select 1');
    });

    expect(recorded.statements).toEqual(['begin', 'select 1', 'commit']);
    expect(recorded.released).toBe(1);
  });

  it('rolls back and still releases when the body throws', async () => {
    // A connection not returned to the pool is a connection lost for the
    // lifetime of the process. Ten of those and the service is down, with no
    // error anywhere that says why.
    const { pool, recorded } = fakePool();

    await expect(
      new PostgresClient(pool).transaction(() => Promise.reject(new Error('domain refused'))),
    ).rejects.toThrow('domain refused');

    expect(recorded.statements).toEqual(['begin', 'rollback']);
    expect(recorded.released).toBe(1);
  });

  it('keeps the original error when the ROLLBACK itself fails', async () => {
    // The defect this fixes. A dropped connection makes `rollback` throw
    // "Connection terminated", and the previous version rethrew that — so
    // during a database blip the actual cause of every transaction failure was
    // discarded and every log line said the same useless thing.
    const { pool, recorded } = fakePool({
      onQuery: (sql) => {
        if (sql === 'rollback') throw new Error('Connection terminated unexpectedly');
      },
    });

    await expect(
      new PostgresClient(pool).transaction(() => Promise.reject(new Error('the real reason'))),
    ).rejects.toThrow('the real reason');

    expect(recorded.released).toBe(1);
  });

  it('releases when the COMMIT fails', async () => {
    const { pool, recorded } = fakePool({
      onQuery: (sql) => {
        if (sql === 'commit') throw new Error('deadlock detected');
      },
    });

    await expect(
      new PostgresClient(pool).transaction(() => Promise.resolve('done')),
    ).rejects.toThrow('deadlock detected');

    expect(recorded.released).toBe(1);
  });

  it('does not swallow a failure to acquire a connection', async () => {
    // A pool that cannot hand out a connection is a dependency outage. The
    // caller has to see it: a transaction that silently did nothing is worse
    // than one that failed.
    const { pool } = fakePool({ connectRejects: new Error('timeout exceeded when trying to connect') });

    await expect(
      new PostgresClient(pool).transaction(() => Promise.resolve()),
    ).rejects.toThrow(/timeout exceeded/);
  });

  it('runs a nested transaction inline rather than pretending to nest', async () => {
    // Honest rather than silently flat: nesting would need savepoints, and no
    // caller needs partial rollback yet. A second `begin` on the same
    // connection is a warning from PostgreSQL and a lie in the code.
    const { pool, recorded } = fakePool();

    await new PostgresClient(pool).transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.query('select 2');
      });
    });

    expect(recorded.statements).toEqual(['begin', 'select 2', 'commit']);
  });

  it('keeps every statement in a transaction on the SAME connection', async () => {
    // The whole point of checking one out. A statement that went back through
    // the pool would run outside the transaction and commit on its own.
    const { pool, recorded } = fakePool();

    await new PostgresClient(pool).transaction(async (tx) => {
      await tx.query('insert 1');
      await tx.exec('insert 2');
    });

    expect(recorded.statements).toEqual(['begin', 'insert 1', 'insert 2', 'commit']);
    expect(recorded.released).toBe(1);
  });
});

describe('closing', () => {
  it('ends the pool', async () => {
    const { pool, recorded } = fakePool();

    await new PostgresClient(pool).close();

    expect(recorded.ended).toBe(true);
  });

  it('is idempotent, because the second close comes from the shutdown path', async () => {
    // `pg` throws "Called end on pool more than once". A framework shutdown
    // hook running after an explicit close would make `app.close()` reject, and
    // the shutdown sequence would report a failed stop and exit non-zero on a
    // perfectly clean one. Found by a readiness test whose own teardown failed.
    let ends = 0;
    const pool = {
      end: () => {
        ends += 1;
        if (ends > 1) throw new Error('Called end on pool more than once');
        return Promise.resolve();
      },
    } as unknown as Pool;

    const client = new PostgresClient(pool);
    await client.close();

    await expect(client.close()).resolves.toBeUndefined();
    expect(ends).toBe(1);
  });
});

describe('a plain query', () => {
  it('reports rowCount as a number even when the driver omits it', async () => {
    // `pg` returns null for statements that do not touch rows, and `rowCount ??
    // 0` is the only thing between that and `undefined` reaching a caller that
    // compares it to zero.
    const pool = {
      query: () => Promise.resolve({ rows: [], rowCount: null }),
    } as unknown as Pool;

    const result = await new PostgresClient(pool).query('create index concurrently x on y (z)');

    expect(result.rowCount).toBe(0);
  });
});
