# Citizens module — backend handoff (Part A)

Branch `feature/citizens`. Baseline `npm run verify` on this branch before any
change: green (typecheck, lint, full Jest suite — the same 88-suite baseline the
session's earlier prod-readiness pass already established at 1821/1821).

## What was built

`GET/POST/DELETE /staff/citizens/*` — a citizen account (`accounts.kind =
'applicant'`, joined to `applicants`), administered by staff. New files:

- `db/migrations/049_citizen_administration.sql` (+ `db/rollback/049_*.sql`) —
  `accounts.disabled_reason text`, plus `applicants(lower(last_name),
  lower(first_name))` for the list screen's search.
- `src/modules/identity/application/citizen-directory.service.ts` — the service.
- `src/modules/identity/transport/staff-citizens.controller.ts` — the routes.
- `src/modules/identity/domain/account.ts` — new `citizens:read` scope, granted
  to `receiving-officer`, `records-officer`, `administrator` (and, via the
  existing union derivation, `super-admin`). Mutations stay behind
  `staff:administer` (administrator/super-admin only), same as the staff
  directory.
- `src/modules/compliance/domain/personal-data.ts` — classified
  `accounts.disabled_reason` as `content('account-lifetime', ACCOUNTABILITY)`.
- `src/modules/identity/application/account-recovery-mailer.ts` — added a `real`
  passthrough getter (mirrors `ContactVerificationMailer`'s own), so the
  password-reset-link route can report `sent`/`not-sent`/`failed` honestly
  instead of always claiming success.
- `test/staff-citizens.e2e-spec.ts` (21 tests) and an addition to
  `test/staff-roles.e2e-spec.ts` (percent-encoded + case-variant probe of
  `/staff/citizens`, mirroring the existing `/staff/businesses` one).

## Human decisions made along the way (flagged per the module brief's Ground Rule 7)

**Migration is 049, not 048.** The brief said "048_citizen_administration.sql,"
written before this session's earlier work had already claimed migration 048
for `048_registration_email_verification.sql` (committed to `main` before this
branch was cut). Renumbered to 049; every in-code comment referencing "migration
048" was updated to say 049.

**`disabled_reason`'s personal-data classification.** The register has a real
precedent split: `payments.rejection_reason`/`exception_reason` are `none`
(officer's note about a *transaction*), `documents.review_remark` is `content`
(officer's note about a *specific applicant*, may name them). A citizen-account
disable reason is squarely the second shape — classified `content`, not `none`.
Not `pii:`-tagged in the migration's own SQL comment (that tag is reserved for
the unambiguous cases; this one is closer to a judgment call, recorded here
instead).

**`CitizenSession.device` is always `null`.** The schema has no link from a
refresh-token family to a `devices` row (`devices` carries `account_id` and a
platform, not a `family_id`). Inventing one from the account's most-recent
`devices` row would attribute one session's platform to a possibly different
session. Left in the response shape as an honest `null` rather than dropped,
because the product intent is real even though the schema doesn't support it
yet. If this needs to be real, `refresh_tokens` needs a `device_id` column (or
similar) at mint time — not attempted here, out of scope for this module.

**Rectification and erasure are NOT reimplemented.** `RectificationService
.rectify()` and `ErasureService.erase()` are called unmodified — this service
wraps each with its OWN audit entry (`citizen.rectified`,
`citizen.erasure.requested`) naming the STAFF actor and the reason, because
those two services' own entries are self-attributed (the only actor self-service
`PATCH /me` / `DELETE /me` ever has) and have no way to say "an officer did this
on the citizen's behalf, for this stated reason." Two entries per act, by
design — see `citizen-directory.service.ts`'s own module comment.

**Idempotency-Key reuse across two DIFFERENT operations is not handled
gracefully — it 500s.** `idempotency_keys`'s primary key is `(account_id, key)`,
with no `operation` column in the key. `lookup()` (shared
`persistence/idempotency.ts`) filters by operation too, so reusing the same key
for, say, `disable` then `enable` finds no existing row (operation mismatch),
proceeds as "fresh," and the second `remember()` collides on the primary key —
an unhandled 500, not the clean 409 a same-operation reuse gets. **This is a
pre-existing systemic gap in shared infrastructure**, reachable from EVERY
staff mutation in this codebase that uses `lookup`/`remember`, not something
introduced by or specific to the Citizens module — confirmed by tracing
`persistence/idempotency.ts` itself. Not fixed here: fixing it well means either
composite-keying on `(account_id, key, operation)` (a migration touching a
table every staff mutation writes to) or catching the unique-violation in the
shared helper and translating it to `key-reused` — both are cross-cutting
changes affecting `staff-business-registration.service.ts` and every other
`remember()` call site, not a citizen-module-scoped fix. `test/staff-citizens
.e2e-spec.ts`'s own idempotency test is written against the SAME-operation case
this system actually protects, with the gap documented in its own comment.
**Recommend filing this as its own follow-up**, not folded into this module.

## A2 — role/route reconciliation

`citizens:read` → `receiving-officer`, `records-officer`, `administrator` (and
`super-admin` via the existing `SUPER_ADMIN_SCOPES` union derivation — no
separate grant needed). Every mutation stays behind `staff:administer`
(administrator/super-admin only), matching the module brief exactly.
`staff-roles.e2e-spec.ts`'s existing generic route-discovery tests ("no staff
route unreachable by any real role," "auditor refused on every mutating staff
route," "no applicant token reaches any /staff route") already cover every new
route automatically, since they discover the route table from the live Fastify
app rather than a hardcoded list — the only addition needed was the
percent-encoded/case-variant probe specific to `/staff/citizens`.

## A3 — response shapes

Matches the brief. List row omits mobile number and address. Detail adds
`mobileNumber, disabledAt, disabledReason`, the profile fields, `businesses[]`,
`applications[]`, `sessions[]`, and up to 50 audit entries via
`AuditService.historyOf('account', citizenId)` — the SAME method
`GET /staff/audit/:subjectType/:id` is built on, not a duplicated query. Every
`GET /staff/citizens/:id` call appends a `citizen.viewed` audit entry (awaited,
not fire-and-forget) before returning, per NPC Circular 16-01's "who VIEWED,
not only who changed" requirement.

## A4 — migration

Additive only. `pii:` comment added per the migration's own convention.
`personal-data.spec.ts`'s completeness/consistency tests (already existing,
unmodified) pass against the new column. Rollback file written; not yet
exercised against a populated `disabled_reason` (lossy once anything populates
it — see the rollback file's own comment).

## A5 — contract

`scripts/emit-response-samples.ts` extended with a `staff.citizens.*` section:
reads (`list`/`metrics`/`detail`/`sessions`) against the SAME seeded applicant
every other sample in the file already depends on (read-only, changes nothing);
every mutation (`rectify`/`password-reset-link`/`sessions.revoke`/`disable`/
`enable`/`erase`) against a SEPARATE, dedicated throwaway citizen created just
for this section, specifically so it cannot disable/erase the shared applicant
account the file's OWN final samples (`me.export`, `me.erase`) still need alive.
Placed after `staff.audit.stream` and before the file's existing "last, because
it disables the applicant account" `me.erase` sample, preserving that ordering
constraint. **Not yet run** — `npm run emit:samples` / `npm run audit:reachability`
/ `npm run audit:samples` should be run once this branch is otherwise green, to
regenerate `contract/route-table.json` and `contract/response-samples.json` for
real and confirm the sample-coverage floor still holds (it should only rise:
every new route got at least one recorded sample).

## A6 — tests

`test/staff-citizens.e2e-spec.ts`: 21 tests, all against PGlite. Covers: list
search escaping (`%`/`_`), pagination bounds, metrics arithmetic, the
404-not-403 posture for a staff account id (and for a nonexistent id,
identically), `citizen.viewed` auditing, disable/session-revocation taking
effect on an ALREADY-ISSUED access token's next request (not just future
sign-ins) and on an already-issued refresh token, missing-reason → 400 before
any write, idempotent replay, idempotency mismatch (same-operation case — see
the gap noted above), the rectification field allow-list (email refused),
erasure calling through to `ErasureService` with the application surviving and
a second staff-attributed audit entry, and a citizen token's 403 +
`authorisation.refused` audit entry.

**A real bug found and fixed while writing these tests, not in review**:
`detail()`'s SQL selected `to_char(ap.date_of_birth, 'YYYY-MM-DD')`, but
`applicants.date_of_birth` is `text` (migration 038, deliberately — it stores a
possibly-partial or non-Gregorian date as entered), not a real `date` column.
`to_char(text, ...)` doesn't exist in Postgres; every detail read 500'd. Fixed
by selecting the column directly — it's already in `'YYYY-MM-DD'` string form,
enforced by migration 038's own check constraint.

**A real deadlock found and fixed**: `revokeAllSessions` and
`sendPasswordResetLink` both originally ran their delegate call (
`TokenService.endAllSessions`, `IdentityService.beginPasswordReset`) INSIDE
this service's own idempotency-lookup transaction. Both delegates open their
OWN `db.transaction()` internally — nesting one inside the other hangs PGlite
(single connection) until the test times out, the exact shape
`rectification.service.ts`'s own doc comment already warns about for the
identical reason. Fixed by moving both to run sequentially, outside any
wrapping transaction (`withDelegateTransaction`, not `withOwnTransaction` — see
the two helper methods' own comments in `citizen-directory.service.ts`).

## Status

`npm run verify` (typecheck + lint + full test suite): **last run in progress
at handoff time** — kick off `npm run verify` fresh on this branch and confirm
green before merging; `test/staff-citizens.e2e-spec.ts` and the
`staff-roles.e2e-spec.ts` addition were run in isolation and are green (21 + 33
tests respectively). Not yet deployed anywhere — see Part D in the module brief
for the deploy order (backend before admin portal) and `api-deployment-linode`
memory for the actual deploy procedure (`apps/ebpco-api/deploy/push-source.sh`
against the Linode host, via an isolated `git worktree` if any peer session has
uncommitted work in this same checkout at deploy time).
