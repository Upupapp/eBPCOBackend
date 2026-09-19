# Production-readiness pass — backend handoff

Ongoing. Work happened directly on `main` (a `prod-readiness` branch was created,
then abandoned at the owner's direction partway through — everything below is on
`main`, and `origin/prod-readiness` is a stale, unused ref left behind by that).

## What changed

**A1 — staff-route percent-encoding auth bypass (CRITICAL, live).**
`AuthenticationGuard` checked `path.startsWith('/staff/')` against the raw
`request.url`. Fastify's router (find-my-way) decodes unreserved percent-escapes
before matching a route, so `GET /%73taff/businesses` routed to the same
staff-only controller as `/staff/businesses` while the raw string did not start
with `/staff/` — confirmed live: an applicant token got a 200 with real business
data back. Fixed by reading `request.routeOptions.url` (the matched route
PATTERN, immune to encoding/case by construction) instead. Added defense-in-depth
`caller.kind === 'staff'` checks to `staff-businesses.controller.ts`'s `list()`
and `detail()` — the exact route the guard's own doc comment names as having
already leaked once. Regression test in `test/staff-roles.e2e-spec.ts`.

**Refresh-token concurrent-replay race.** `rotate()` read `consumedAt`, decided
it was null, then wrote it — two requests for the identical refresh token could
both pass the read before either wrote, so both minted a session from one
single-use token. `markConsumed()` now performs the guarded `UPDATE ... WHERE
consumed_at IS NULL` and reports whether its OWN call won, atomically. Losing the
race is treated exactly like a genuine replay (family revoked). Tested against
both the in-memory and real-Postgres adapters.

**Contact-verification OTP digest.** Was bare, unkeyed SHA-256 over a six-digit
code — precomputable in bulk, in well under a second, by anyone who could read
`contact_verification_challenges`. Now HMAC-SHA256 peppered with the same
`PASSWORD_PEPPER` `PasswordHasher` already uses (reused deliberately rather than
adding a new required secret across ~26 e2e fixtures).

**scrypt cost-parameter DoS.** A stored password verifier's own N/r/p were
trusted with no ceiling before being handed to `scrypt`, whose memory cost (128 ×
N × r bytes) has no upper bound of its own. **Live-proven during this session**:
a verifier carrying N = 4,194,304 hung the process and grew its memory footprint
for over a minute before being killed by hand. Now bounded to 4×/2× this
process's own defaults, and a non-power-of-two N is refused outright (real
`scrypt` would otherwise throw, uncaught, out of `verify()`).

**Pre-existing gaps fixed as groundwork, not findings:**
- `npm run test`/`verify` invoked `node node_modules/.bin/jest`, which is a
  POSIX shell shim on Windows (not the real JS entry point) — `verify.sh`
  could never actually run its test stage on this machine. Now points at
  `node_modules/jest/bin/jest.js` directly, which works on both platforms.
- 4 pre-existing lint errors unrelated to this pass (see commit `52d5ed1`).

## How it was verified

- `npm run typecheck && npm run lint`: clean after every change.
- `npm test` (full suite): **88 suites, 1790 tests, all passing** — last full run
  after all four fixes above landed together (`2671.7s`).
- Every fix above has a dedicated regression test proved to fail against the
  pre-fix code and pass against the post-fix code (not just written and assumed
  correct) — for the scrypt fix, "fails before" was an actual process hang, not
  a test assertion.
- `npm run audit:reachability`: **does not pass** — see gaps below.
- `npm run audit:samples`, `npm run build`, `python3 scripts/scan-secrets.py`:
  not run this session; unknown state, not "verified passing."

## What remains for a human

1. **`npm run audit:reachability` reports ~18 pre-existing drift entries**
   (`payments/reconciliation.ts`, `notifications/catalog.ts` and
   `staff-catalog.ts`, `persistence/personal-data-inventory.ts`, `payments/domain/money.ts`
   and `order-of-payment.ts` — symbols the register lists as reachable only from
   tests that the tool now finds reachable from real code too). Confirmed this
   predates the session's own changes (none of the touched files import any of
   these). Each entry needs someone who knows whether the register is stale or
   the reachability genuinely changed — not something to bulk-edit blind.

2. **Payment-submission idempotency-insert race.** `PaymentService.submitPayment`
   does check-then-insert on `idempotency_keys` the same shape the refresh-token
   bug had, but the outcome is different: the primary key on
   `(account_id, key)` means a losing concurrent request's transaction rolls
   back entirely (confirmed — `SqlClient.transaction()` rolls back on any
   thrown error), so **no duplicate payment is ever persisted**. What it does
   produce is an uncaught Postgres unique-violation error surfacing as a raw
   500 to a legitimate double-submit or network-retry, instead of the graceful
   idempotent replay this function already handles for the sequential case.
   Not fixed this session: doing it cleanly means catching Postgres error code
   `23505`, a pattern this codebase does not use anywhere else yet, and it's a
   reliability gap, not a security or data-integrity one. Fix shape: catch
   `23505` on the `idempotency_keys` insert, re-`SELECT` the row the winner
   wrote, and return that — mirroring the existing sequential-replay branch a
   few lines above it.

3. **`origin/prod-readiness` (this repo, and both frontend repos) could not be
   deleted.** `git push origin --delete prod-readiness` hangs indefinitely on a
   Git Credential Manager prompt in this environment — no interactive terminal
   to complete it, and no `gh` CLI installed. Delete via the GitHub web UI, or
   leave it; nothing targets it going forward.

4. **The real environment (`139.162.51.165` / `139-162-51-165.sslip.io`) is
   already live** and predates this pass (see `deploy/`, `docs/DEPLOYMENT.md`).
   Not touched or tested against during this pass, per the ground rule that set
   it out of scope — the fixes above were verified against PGlite only, the
   same as every other test in this suite.

5. **Sign-out and session-expiry were not touched**, per the explicit
   constraint. The refresh-token fix changes WHEN a family gets revoked (a
   losing concurrent request now revokes it, same as an outright replay would)
   but not the revocation mechanism itself, token TTLs, or storage.

## Not yet started

B (Admin Portal) and C (User Portal) each have some real fixes landed this
session (CSV/formula injection, security headers on both Netlify deploys,
`.playwright-mcp` repo hygiene, a stale citizen-facing honesty defect on
registration, a broken in-place legal-document link, two test files left behind
by an unrelated notification-bell fix) but were not worked through
systematically the way Part A was. D (cross-cutting: drift-detection scripts,
this document itself) is partial — this document exists, the shared-code
drift-detection scripts described in the original spec were not built.
