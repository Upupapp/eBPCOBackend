# PENDING — the Municipal ruling on renewal, amendment and re-certification

Owner ruling relayed 2026-09-03 (bus #0042/#0043), confirmed 2026-09-05 (#0045).
This register exists because three of the four obligations are backend work that
is **not built**, and two front-end lanes are about to build against it.

## The ruling

1. **Renewal** — nothing may be omitted. All twenty-two documents stay. A
   document already on file is **reused by default**, the citizen may change it,
   and every reuse is **flagged to the admin**.
2. **Amendment** — amended items **remove** the old items; everything else is
   reused in place and changes only if the citizen changes it.
3. **Re-certification** — **not required**. A reused document past validity is
   accepted. The admin sees a note saying it is reused **and the date it was
   certified**, and decides.

## Answered already, by measurement — no work needed

**Nothing server-side refuses a reused document for age.** Checked at `6155e47`
and relayed as bus #0347.

Every occurrence of `expires_on` / `expiresOn` in production source is a read —
a projection into a response, or an entry in the personal-data register. There
is no comparison against a date, no branch on an expiry, and nothing that
refuses. Every `expired` in the codebase belongs to TOTP enrolments,
verification codes, JWT/refresh tokens, or the data-export sweep; none is in a
document path.

The complete set of reasons a filing can be refused is `no-applicant-record`,
`unknown-permit-type`, `business-not-yours`, `documents-not-yours`,
`requirement-unknown`, `key-reused`, `form-rejected`. Expiry is not among them
and never has been.

*A negative result is still a result: the citizen lanes can send a reused
document of any age, and a client-side block would not be mirroring a server
rule because there is no rule to mirror.*

## PENDING — 1. The original certification date

**Why it is not built:** nobody asked for it until the ruling. `documents` has
`expires_on` and `uploaded_at` and nothing that records **when a thing was
certified**. citizen-web asked for `expiresOn` on the library record and got it;
the ruling needs more, because an expiry date cannot say when a document was
certified, and the admin's note is built from the certification date.

**What it needs:** a column on `documents`, carried into the citizen library
(`GET /documents/me`), the application document list, and the **admin** surface —
the note is rendered there. It is personal data about a named citizen's
submission and needs a register entry with its own purpose.

**Open question for the owner:** who supplies it? A certification date is on the
face of the document, so either the citizen types it at upload, or an officer
records it at review. That decides whether it is a nullable field the citizen
fills or a review-time field, and it is a workflow decision rather than an API
one.

## PENDING — 2. A `reused` flag on the application document

**Why it is not built:** the existing chain records the wrong relationship.
`documents.supersedes_document_id` (migration 027) says *this file replaces that
file*. Reuse is a different fact: *this filing points at a document that was
already on file*. The admin flag is a fact about **this filing**, not about the
file, so it cannot live on `documents` alone.

**What it needs:** the flag on the link between an application and a document,
set when a filing reuses rather than uploads, and exposed to the admin queue.

## PENDING — 3. Amendment supersession in scope

**Why it is not built:** the supersession chain is **per document** and nothing
applies it to an amendment's item set. The ruling says amended items *remove*
the old items — which must supersede rather than delete, or the previous filing
loses its evidence, and a permit record that cannot show what it was judged on
is not a record.

## PENDING — 4. Name both fields in the contract before either lane builds

`contract/citizen-endpoints.openapi.yaml` must carry the certification-date
field and the exact name of the reused flag **before** citizen-web and
citizen-mobile build against them.

This is not process for its own sake. `PATCH /me` shipped as a working handler
with a recorded sample and no path in the contract; citizen-web got it right
only by reading the zod schema, and citizen-mobile — which works from the
contract — would have found nothing and guessed the field names. Two lanes
guessing independently is how one idea acquires two spellings, which is what
D-10 spent a migration undoing.

The route-coverage register (`citizen-route-coverage.spec.ts`) now fails on an
undeclared citizen route, so a new path cannot ship silently. It does not catch
a new **field** on an existing path.
