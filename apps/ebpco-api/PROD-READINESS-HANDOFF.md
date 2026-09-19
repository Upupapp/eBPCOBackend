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

2. **Idempotency-insert race is systemic, not payment-specific.**
   `PaymentService.submitPayment` does its own inline check-then-insert on
   `idempotency_keys`, the same shape the refresh-token bug had. Checked
   further this session: the SAME shape is shared, via
   `persistence/idempotency.ts`'s `lookup()`/`remember()`, by
   `lifecycle.service.ts`, `submission.service.ts`,
   `staff-business-registration.service.ts` and `document.service.ts` — every
   idempotent write in the backend. In every case the outcome is the same:
   the primary key on `(account_id, key)` means a losing concurrent request's
   transaction rolls back ENTIRELY (confirmed — `SqlClient.transaction()`
   rolls back on any thrown error), so **no duplicate write is ever
   persisted** anywhere this pattern is used. What it produces instead is an
   uncaught Postgres unique-violation error surfacing as a raw 500 to a
   legitimate double-submit or network-retry, instead of the graceful
   idempotent replay each of these already handles for the SEQUENTIAL case
   (an already-consumed key, read before the write).

   **Deliberately not fixed this session**, and not a small change: a naive
   fix — make `remember()` use `ON CONFLICT DO NOTHING` and return a boolean
   instead of throwing — would REMOVE the rollback that currently makes this
   safe, unless every one of the 7 call sites is also changed to explicitly
   re-throw (or otherwise abort the transaction) on a lost race. Get that
   wrong at even one call site and a losing request's own domain write
   (an application submission, a business registration, a document
   operation) commits ALONGSIDE the winner's — turning a reliability papercut
   into the first actual duplicate-write bug in this system. Doing it
   correctly means auditing all 7 call sites' domain semantics individually,
   not a mechanical find-and-replace. Fix shape, once someone has done that
   audit: `remember()` keeps throwing (preserving the rollback) but with a
   typed, catchable error; each call site catches it OUTSIDE its own
   transaction and re-runs `lookup()`, which will now find the winner's
   committed row, and returns that — mirroring the sequential-replay branch
   each one already has.

3. **No account-specific lockout/backoff on repeated failed sign-ins.**
   `IdentityService.authenticate()` is otherwise carefully built against
   enumeration — a decoy scrypt hash so an unknown email takes the same wall
   time as a wrong password, one unified `'rejected'` reason for
   no-account/wrong-password/disabled, MFA failures only distinguishable
   because the password was already proven. All of that is real and correct.
   What is missing is any per-account or per-IP counter: `recordRefusal()`
   writes an audit entry for visibility, not a lockout. The only throttle on
   repeated guesses against ONE account is the GLOBAL HTTP rate limiter
   (`security.ts`, shared across all traffic to all routes) plus scrypt's own
   per-attempt cost — neither stops a distributed attempt (many source IPs,
   each under the global budget, guessing the same account in aggregate).
   Not implemented this session, deliberately: unlike everything else in this
   document, this is a genuine new feature with real product trade-offs
   (threshold, backoff curve or hard lockout, and critically how to avoid
   the lockout itself becoming a DoS vector — an attacker who cannot guess a
   password can still fail it deliberately to lock out the real owner), not
   a narrow fix to an existing, documented invariant. A human should decide
   the shape before it gets built.

4. **`origin/prod-readiness` (this repo, and both frontend repos) could not be
   deleted.** `git push origin --delete prod-readiness` hangs indefinitely on a
   Git Credential Manager prompt in this environment — no interactive terminal
   to complete it, and no `gh` CLI installed. Delete via the GitHub web UI, or
   leave it; nothing targets it going forward.

5. **The real environment (`139.162.51.165` / `139-162-51-165.sslip.io`) is
   already live** and predates this pass (see `deploy/`, `docs/DEPLOYMENT.md`).
   Not touched or tested against during this pass, per the ground rule that set
   it out of scope — the fixes above were verified against PGlite only, the
   same as every other test in this suite.

6. **Sign-out and session-expiry were not touched**, per the explicit
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
