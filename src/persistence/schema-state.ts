import { AppliedMigration, Migration, checksum } from './migrator';

/**
 * Whether this build understands the schema it is pointed at.
 *
 * The check this replaces compared **counts**: `expected.length -
 * applied.length`. Three things it could not see, all of which produce a
 * process that serves requests against a schema it does not understand.
 *
 * A migration edited after it was applied — the count matches, the checksum
 * does not, and the database is not what the code was tested against. That is
 * the most common way this goes wrong in practice, because editing a migration
 * "just to fix the comment" is a thing people do.
 *
 * A migration renamed or replaced. Same count, different file.
 *
 * And a database AHEAD of the build, which produced a negative number, which is
 * not greater than zero, which reported healthy. An old build serving against a
 * newer schema is the exact state a rollback creates.
 */

export type SchemaVerdict =
  /** The ledger and the build agree, migration for migration. */
  | { readonly state: 'current' }
  /** Migrations this build expects that the database has not applied. */
  | { readonly state: 'behind'; readonly missing: readonly string[] }
  /** Applied under a version this build also has, with different content. */
  | { readonly state: 'divergent'; readonly divergent: readonly string[] }
  /** The database has migrations this build does not know about. */
  | { readonly state: 'ahead'; readonly unknown: readonly string[] };

export function compareSchema(
  expected: readonly Migration[],
  applied: readonly AppliedMigration[],
): SchemaVerdict {
  const byVersion = new Map(applied.map((row) => [row.version, row]));

  // Divergence first. A checksum mismatch means the database was built by a
  // file that no longer exists, and reporting "behind" or "ahead" for it would
  // send an operator to run a migration that will not fix anything.
  const divergent = expected
    .filter((migration) => {
      const row = byVersion.get(migration.version);
      return row !== undefined && row.checksum !== checksum(migration.sql);
    })
    .map((migration) => `${migration.version} ${migration.name}`);
  if (divergent.length > 0) return { state: 'divergent', divergent };

  const missing = expected
    .filter((migration) => !byVersion.has(migration.version))
    .map((migration) => `${migration.version} ${migration.name}`);
  if (missing.length > 0) return { state: 'behind', missing };

  const known = new Set(expected.map((migration) => migration.version));
  const unknown = applied
    .filter((row) => !known.has(row.version))
    .map((row) => `${row.version} ${row.name}`);
  if (unknown.length > 0) return { state: 'ahead', unknown };

  return { state: 'current' };
}

/**
 * What a verdict means for taking traffic.
 *
 * `behind` and `divergent` are refusals. The code expects tables, columns or
 * constraints that are not there, and every request that touches them fails —
 * better to fail the health gate and never enter rotation than to serve errors
 * that look like application bugs.
 *
 * `ahead` is **degraded, not down**, and that is the decision worth arguing
 * about. It is tempting to refuse: the database has changed in ways this build
 * has not seen. But it is also the normal state of every rolling deploy that
 * migrates before it rolls, and of every rollback — and a build that refuses to
 * serve whenever the schema is newer than itself takes the whole service down
 * at exactly the moment someone is trying to recover it.
 *
 * That is only safe because the migrations are expand-then-contract: a release
 * adds, and a later release removes once nothing reads the old shape. If that
 * discipline is ever broken, this becomes wrong — which is why the state is
 * reported loudly rather than silently tolerated.
 */
export function servesTraffic(verdict: SchemaVerdict): boolean {
  return verdict.state === 'current' || verdict.state === 'ahead';
}

/** One line an operator can act on, naming the migrations rather than counting them. */
export function describe(verdict: SchemaVerdict): string {
  switch (verdict.state) {
    case 'current':
      return 'schema matches this build';
    case 'behind':
      return `${verdict.missing.length} migration(s) not applied — this build expects a schema the database `
        + `does not have: ${verdict.missing.join(', ')}`;
    case 'divergent':
      return `${verdict.divergent.length} migration(s) were applied from different content than this build `
        + `carries: ${verdict.divergent.join(', ')}. The database was not built by these files; running them `
        + 'again will not fix it.';
    case 'ahead':
      return `the database has ${verdict.unknown.length} migration(s) this build does not know about: `
        + `${verdict.unknown.join(', ')}. Serving anyway, because a rolling deploy migrates before it rolls `
        + 'and refusing here would take the service down mid-release.';
  }
}
