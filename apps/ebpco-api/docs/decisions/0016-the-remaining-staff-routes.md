# ADR 0016 — The rest of the officer's work

**Status:** Accepted
**Date:** 20 August 2026
**TAB:** 15. Closes divergence R-27.

## What was missing

TAB 13 routed the queue and the transition. Everything else an officer does —
evaluate, assess, verify a payment, generate a permit, release it — had no
route, so the admin's buttons threw `NotOnTheServerYet`. Two of those did not
even have a service: nothing had ever written an `evaluations` row or a
`generated_permits` row.

That mattered more than a missing screen. `evaluations-complete` is a
precondition on two transitions, and with nothing able to write an evaluation
**it could only ever be false** — so `Under Evaluation → Assessed` and
`For Approval → Approved` were unreachable by anyone. The permit lifecycle
stopped dead in the middle.

## The defect this uncovered

`Approved → Permit Generated` carried `preconditions: []`.

An officer could set the status, the applicant would be notified that **their
permit had been generated**, and no permit existed. An applicant may travel to a
counter on the strength of that notification. It is the same class of failure as
showing a queued submission as submitted, and worse in its consequence.

The transition now requires `permit-generated`. The order is: generate the
permit, then move the status. There is a test that tries it the other way.

## Decisions

**A stage is decided once, in order.** Re-deciding is refused rather than
overwritten: an evaluation an applicant was shown, silently replaced, is a
record that no longer matches what they were told, and the honest correction is
a new cycle through Revision Required. The order is enforced because Fire Safety
examines a plan the OBO has not yet checked structurally — passing a later stage
first produces a record saying an application was cleared on evidence nobody
had. An out-of-order attempt is refused **with the stage that is actually next**.

**An officer may not evaluate their own application.** Not hypothetical: staff
apply for permits on their own houses.

**Adverse results need remarks, at least a sentence, kept verbatim.** The
database already refused them; this refuses earlier and says which field. A
paraphrase of "sheet S-3 is unsigned" is not actionable.

**`evaluationsComplete` is returned with the write.** The alternative is a
second request that races the first.

**Verification requires an Official Receipt number.** Without it the payment
cannot be reconciled against the Treasurer's records, which is the only thing
that makes the verification true. Self-verification is `403` and not `409`: the
caller is not permitted, and telling them the payment is in the wrong state
would send them to fix something that is not wrong.

**Release is two steps.** Preparing the claim details happens earlier, by a
different person, and an applicant needs them *before* they travel. The
claimant's name is required at release because it is the only evidence of who
took the document — "Authorized Representative" with no name is a permit handed
to nobody in particular.

**Refusals are `422` unless they are something else.** The request was well
formed and the caller was entitled to make it; something about the application
is not yet true. That is a step to take, not a mistake to correct.

## A defect the recorded samples caught, again

The first permit numbering counted existing permits and added one. The sample
emitter issued **`FP-2026-000002` into a fixture that already held
`FP-2026-000212`**.

It is wrong twice. It collides the moment a number did not come from the counter
— a migrated record, a hand-corrected one — and it is not concurrency-safe: the
row lock held was on `applications`, and two applications approved at the same
instant take two different locks and read the same count. The unit test passed
only because PGlite serialises.

Migration 010 adds `document_number_sequences`, incremented by a single upsert
so PostgreSQL serialises it on the primary key. It is seeded from the maximum
already present, so a migrated database does not start reissuing.

A duplicate permit number is not a display bug: it is two buildings whose
paperwork cannot be told apart.

## And one more, from the same place

The prefix table invented permit-type names — "Building Permit", "Occupancy
Permit" — that `permit_types` does not have. Every real application would have
fallen through to the generic prefix and **no test would have said so**. Fixed
against the reference table, with a standing test that every seeded permit type
has a prefix and that no two share one.

## What is still not routed

- **Recording an onsite payment.** The applicant-side proof endpoint is not a
  substitute: it records the *applicant* as having submitted, which would let one
  officer both record and verify a walk-in payment and defeat the separation of
  duty the server enforces. It needs its own route, with the cashier as
  submitter.
- **Assisted filing, cancellation, editing an application, notifications,
  reordering.** No endpoints; the admin still throws for these, loudly.
- **Businesses, Users & Roles, System Logs, Workflow** in the admin still have
  no server at all.
- **`Order of Payment` numbers are a hex fragment** (`OP-2026-3E5EA7E7`), not a
  sequence. An applicant quotes that number to a cashier, and it is materially
  worse to read aloud than `OP-2026-000019`. Pre-existing, left alone here
  rather than changed as a side effect, but it should move to the same counter
  the permit numbers now use.
