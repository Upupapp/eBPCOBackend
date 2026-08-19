# ADR 0006 — Migrations are forward-only, checksummed, and never run at boot

**Status:** Accepted
**Date:** 19 August 2026

## Decision

Three properties, each answering a specific way schema management fails.

**Forward-only.** There are no `down` scripts. A down migration is a promise
that a rollback will be tested, and it almost never is. Worse, it invites a
release that drops a column — which cannot be rolled back at all once the rows
are gone. The rollback path is instead **expand → migrate → contract**: every
intermediate schema is one the previous release can still run against, so
rolling back means redeploying the previous image and nothing else.

**Checksummed.** An applied migration's content is recorded and verified before
anything new is applied. Editing a file that has already run is refused, because
it produces two databases with the same version number and different shapes —
and the one that is wrong is always production. The checksum ignores
whitespace, so reformatting is not a false alarm, but any change to a statement
is.

**Never at boot.** The service does not migrate on start. N replicas starting
together would race to alter the same schema, and a rollback would have to guess
what had been applied. Migrations run in the deployment pipeline, before the new
version rolls out.

## What replaces the boot-time migration

The database readiness probe reports **down** when the schema is behind the
code. A deploy that skipped its migration step therefore fails its health gate
and never receives traffic, rather than serving requests against a schema it
does not understand. There is a test for exactly this.

The migrator also refuses to run when the *database* is ahead of the build —
an applied version with no corresponding file means an older build is being
deployed onto a newer schema, which is a rollback into a shape the old code has
never seen.

## Consequences

- Every destructive change needs at least two releases. That is the cost, and
  it is the point.
- The pipeline must run migrations. There is no pipeline yet (ADR 0002), so this
  is currently a documented manual step in `docs/DEPLOYMENT.md`, and it is the
  single most important thing to automate when CI capacity returns.
