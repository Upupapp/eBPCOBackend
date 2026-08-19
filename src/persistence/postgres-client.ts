import { Pool, PoolClient } from 'pg';

import { SqlClient } from './sql-client';

/**
 * The pooled PostgreSQL client every deployment uses.
 *
 * `pg` returns BIGINT and NUMERIC as strings, because both can exceed
 * JavaScript's safe integer range. Left as strings they are a live bug: `a + b`
 * on two fee strings concatenates instead of adding, and produces a plausible
 * number rather than an error.
 *
 * So both are parsed here, once and globally rather than at each call site,
 * because the failure mode of forgetting at one call site is a wrong fee rather
 * than a crash. Each parser refuses anything it cannot represent exactly: a
 * value beyond the safe integer range, or a NUMERIC with a fractional part.
 * Every NUMERIC in this schema is centavos and is constrained to scale 0, so a
 * fractional one arriving means the database has been written to by something
 * that bypassed the constraint -- and that must be loud.
 */
import { types } from 'pg';

import { BIGINT_OID, NUMERIC_OID, exactInteger } from './numeric-parsing';

types.setTypeParser(BIGINT_OID, exactInteger('bigint'));
types.setTypeParser(NUMERIC_OID, exactInteger('numeric'));

export class PostgresClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  static fromUrl(connectionString: string, max = 10): PostgresClient {
    return new PostgresClient(
      new Pool({
        connectionString,
        max,
        // A connection that cannot be obtained quickly is a dependency outage,
        // and a request should fail fast rather than queue behind one.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        // A query that has not returned in 30s is not going to.
        statement_timeout: 30_000,
      }),
    );
  }

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.pool.query(text, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const result = await fn(new PooledConnection(connection));
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** One checked-out connection, so every statement in a transaction runs on it. */
class PooledConnection implements SqlClient {
  constructor(private readonly connection: PoolClient) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.connection.query(text, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.connection.query(sql);
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // Already inside one. Nesting would need savepoints, and no caller needs
    // partial rollback yet -- so this is honest rather than silently flat.
    return fn(this);
  }

  close(): Promise<void> {
    // The pool owns the lifetime; releasing happens in PostgresClient.
    return Promise.resolve();
  }
}
