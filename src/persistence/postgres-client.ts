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

/**
 * Pool limits, from configuration rather than compiled in.
 *
 * `max` is PER PROCESS. The failure mode of setting it too high is not this
 * service slowing down: it is exhausting the database server's global
 * connection limit and taking down every other client, including whatever an
 * operator is using to diagnose it.
 */
export interface PoolLimits {
  readonly max: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_LIMITS: PoolLimits = {
  max: 10,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
};

export class PostgresClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  static fromUrl(connectionString: string, limits: PoolLimits = DEFAULT_LIMITS): PostgresClient {
    return new PostgresClient(
      new Pool({
        connectionString,
        max: limits.max,
        connectionTimeoutMillis: limits.connectionTimeoutMs,
        idleTimeoutMillis: 30_000,
        statement_timeout: limits.statementTimeoutMs,
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
      // The rollback is allowed to fail, and its failure must not replace the
      // reason we are rolling back. A dropped connection makes `rollback` throw
      // "Connection terminated" -- and the previous version rethrew THAT, so
      // the actual cause of every transaction failure during a database blip
      // was silently discarded and every log line said the same useless thing.
      //
      // Nothing is leaked by swallowing it: a connection that cannot roll back
      // is destroyed on release rather than returned to the pool, and the
      // server rolls back an abandoned transaction on disconnect.
      try {
        await connection.query('rollback');
      } catch {
        // Deliberately empty. The original error is what the caller needs.
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Idempotent, deliberately.
   *
   * `pg` throws "Called end on pool more than once" on a second call, and that
   * is not an error worth surfacing: the pool is gone, which is what the caller
   * wanted. Surfacing it is actively harmful, because the second close comes
   * from the shutdown path -- a framework shutdown hook running after an
   * explicit close would make `app.close()` reject, and the shutdown sequence
   * would report a failed stop and exit non-zero on a perfectly clean one.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private closed = false;
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
