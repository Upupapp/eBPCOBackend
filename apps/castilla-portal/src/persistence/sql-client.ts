/**
 * The narrow slice of a Postgres driver this service uses.
 *
 * Both `pg.Pool` and PGlite satisfy it as-written, which is the point: the
 * tests run against real PostgreSQL semantics in-process, so a query that
 * passes a test is a query PostgreSQL accepted, not one a mock tolerated.
 */
export interface SqlClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const SQL_CLIENT = Symbol('SQL_CLIENT');
