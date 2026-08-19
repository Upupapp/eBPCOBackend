# ADR 0015 — Record the responses; validate those

**Status:** Accepted
**Date:** 19 August 2026
**TAB:** 14.

## The claim TAB 13 could not make

TAB 13 built the staff surface and migrated the admin onto it. The backend's
e2e suite proved the routes worked. The admin's tests proved its store behaved,
against a fake gateway. **Nothing proved the two halves agreed**, and both
suites were green.

## What this does

`scripts/emit-response-samples.ts` boots the real application — real
controllers, real route table, real migrated PostgreSQL — seeds a dataset with
enough shape to exercise the fields that are usually null, and writes every
response verbatim to the contract repository. `tools/validate_samples.py` there
validates each recorded body against the OpenAPI schema for that path, method
and status.

The samples are **recorded, not written**. A hand-written example states what
someone believed the server returns, and it agrees with the schema because the
same person wrote both. These are the bytes, so a schema that disagrees with
them disagrees with production.

The refusals are recorded too — 400, 404, 409, 412. A client that renders
Problem Details has to be built against the real shape, and each of those is a
different next action for the officer at the counter.

## What it found immediately

**`/me` returned no name.** The contract said `Applicant`; the server returned
an account summary. The Flutter client reads `firstName`, `lastName` and
`mobileNumber` from it and falls back to empty strings — so **every applicant
would have seen a blank name and an empty contact number**, and nothing failed
loudly enough for anyone to notice. `/me` now answers in two shapes
discriminated by `kind`.

**The staff detail endpoint leaked raw database rows.** `snake_case` keys in an
otherwise `camelCase` API, and `select b.*` on the business — sending
`owner_applicant_id`, `created_at` and `updated_at` to every officer's browser.
The admin's own mapper had already grown `row['uploaded_at'] ?? row['uploadedAt']`
hedges, written by someone who could not tell which they would get. Both fixed:
named columns, converted keys.

**A state-changing POST with no `Idempotency-Key`.** The contract's own
IDEMPOTENCY rule caught it. `expectedVersion` answers "has anyone else changed
this since I looked"; it does not answer "did my request already happen". An
officer clicks Receive, the server commits, the response is lost, they retry —
and the server answers *"someone else changed this application while it was
open"*, which is untrue, unhelpful, and in a permit office is a question about
who did what. Transitions now require a key, replay returns the original
result, and the key is written inside the same transaction as the move so a
rolled-back transition cannot leave a key that replays a result nothing
produced.

## Gates that were passing for the wrong reason

Three, all of the same shape: a check whose message claimed more than it did.

- **The mobile endpoint check read one repository file of four.** "All 4
  endpoints" was true of `http_applications_repository.dart` and silently untrue
  of the auth, business and notification repositories beside it. It now reads
  all four and finds nine.
- **The admin endpoint check missed template-literal paths**, so
  `/staff/applications/${id}` and `.../transitions` — the two that matter most —
  were never checked. It reported "all 4 endpoints" while missing them.
- **Then the fix missed one anyway**, because the capture window consumed the
  next call site and `finditer` resumed past it. The count came out plausible
  enough that it took a deliberate recount to notice. The window is a lookahead
  now, and every call site must resolve to a path or the check fails.

The lesson is recorded here rather than just fixed: a gate that passes for the
wrong reason is worse than one that is absent, because it is trusted.

The interface check also now runs in **both** directions. A client omitting a
field is a choice. A client reading a field the server never sends is a defect —
it renders undefined, which looks like missing data rather than a wiring
mistake — and checking one direction finds half of them.

## Deliberate limits

- **PGlite, not a server.** Real PostgreSQL and the real query planner, in
  process. It does not exercise pooling, concurrency at scale, TLS, or a
  reverse proxy. The samples are about *shape*, and the operational half
  belongs to TAB 16.
- **The subset validator refuses what it does not implement.** It covers the
  keywords this document uses and fails on anything else, rather than ignoring
  it. A validator that skips an unknown keyword reports success for a check it
  never made.
- **Samples are only as good as the fixture.** A response where every optional
  field is null proves nothing about the present case, so the fixture carries a
  complete application — order of payment, verified payment, permit, release,
  an open instruction — as well as one mid-flight. Adding a schema without
  adding a sample that reaches it leaves it unchecked, and nothing currently
  detects that.
- **Regenerating is manual.** `npm run emit:samples` is not wired into the
  backend's own gate: it writes into a sibling repository, and a verify step
  that silently edits another checkout is a surprise. The contract's gate skips
  cleanly when the file is absent and validates it when present.
