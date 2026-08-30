/**
 * The narrow surface the persistence layer needs from a database.
 *
 * Deliberately smaller than `pg.Pool`. Two implementations satisfy it: the
 * pooled PostgreSQL client used in every deployment, and PGlite -- real
 * PostgreSQL compiled to WebAssembly -- used by the tests. Because PGlite runs
 * the actual query planner and the actual constraint machinery, a test that
 * proves the database rejects an illegal lifecycle transition is proving it
 * about PostgreSQL, not about a mock that was written to agree.
 *
 * What PGlite does NOT exercise is operational: pooling, concurrency at scale,
 * replication, failover. Those belong to TAB 16 and a real environment, and are
 * recorded as unverified rather than assumed.
 */
export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
  /** Runs one or more statements with no parameters. Used by migrations. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
