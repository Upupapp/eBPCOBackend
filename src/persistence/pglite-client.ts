import { PGlite } from '@electric-sql/pglite';

import { BIGINT_OID, NUMERIC_OID, exactInteger } from './numeric-parsing';
import { SqlClient } from './sql-client';

/**
 * PostgreSQL compiled to WebAssembly, running in-process.
 *
 * Used by the tests, and the reason the constraint acceptance criteria are
 * *executed* rather than merely written down. This is the real PostgreSQL query
 * planner and the real constraint machinery: when a test proves the database
 * rejects a Submitted-to-Released transition, it is proving something about
 * PostgreSQL, not about a fake that was written to agree with the test.
 *
 * What it does not cover is operational -- pooling, concurrency under load,
 * replication, failover, backup and restore. Those need a real server and
 * belong to TAB 16 and a real environment. They are recorded as unverified.
 */
export class PgliteClient implements SqlClient {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<PgliteClient> {
    return new PgliteClient(
      await PGlite.create({
        // The same parsers the `pg` driver is given in postgres-client.ts.
        //
        // Without them the two adapters disagree: PGlite returns NUMERIC and
        // BIGINT as strings while `pg` returns numbers, so a fee read in a test
        // is "682000" and the same fee read in production is 682000 — and
        // `a + b` on the former concatenates. That divergence was found by a
        // test asserting a zero fee line, and it is exactly the
        // "works in tests, fails in production" class the shared contract suite
        // exists to catch. The adapters must be interchangeable or the tests
        // are testing a different system.
        parsers: {
          [BIGINT_OID]: exactInteger('bigint'),
          [NUMERIC_OID]: exactInteger('numeric'),
        },
      }),
    );
  }

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.db.query<Row>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // PGlite's own transaction helper rolls back on throw.
    return this.db.transaction(async (tx) => {
      const wrapped: SqlClient = {
        query: async <Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
          const result = await tx.query<Row>(text, values as unknown[]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
        transaction: (nested) => nested(wrapped),
        close: () => Promise.resolve(),
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
