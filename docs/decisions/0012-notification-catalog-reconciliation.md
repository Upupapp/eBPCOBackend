# ADR 0012 — The notification catalog is the client's, and TAB 01 should have said so

**Status:** Accepted
**Date:** 19 August 2026

## What happened

TAB 01 reconciled the lifecycle vocabulary across all three tiers, field by
field, and found the two clients had not drifted. It did **not** reconcile the
notification catalog — because at that point the mobile client's
`NotificationType` enum had no wire form at all. It was never serialised, so
there was nothing to compare against.

TAB 08 then wrote a catalog server-side: twenty-four types with names like
`application.assessed`, and five categories of its own invention.

The shipped mobile app already had **twenty-five types**, with applicant-facing
copy, icons, priorities, an N-01..N-24 code scheme, and **six categories that
are already the mute buckets in its Settings screen**.

That is a second vocabulary for one concept, created by the tier whose entire
purpose was to prevent exactly that.

## Decision

**The client's catalog is adopted wholesale**, and the derivation is mechanical
so no judgement is involved:

- **Wire name** = kebab-case of the client's enum constant.
  `orderOfPaymentIssued` → `order-of-payment-issued`.
- **Category** = the client's six, unchanged.
- **`statutory`** = the client's own `action` priority. It had already decided
  which notices require an act.
- **`serverGenerated: false`** for the two the server never sends: `draft-idle`
  (a draft is local until it is filed) and `professional-credential-expiring`
  (computed from records held on the device).

The contract, the database seed, the lifecycle engine and the delivery planner
all follow.

## The gap this exposed, which is NOT closed

Eight lifecycle transitions now carry **no notification**, because the client's
catalog has no counterpart:

`evaluation-started` · `instruction-resolved` · `payment-under-verification` ·
`payment-rejected` · `for-approval` · `completed` · `expired` · `cancelled`

They are left unnotified rather than mapped onto an approximate type, because
telling an applicant "payment overdue" when their payment was *rejected* is
worse than telling them nothing — it sends them to pay again.

`payment-rejected` is the one that matters most: the money may genuinely have
left their account and they need to know why it was not accepted. **Closing
these requires new client types and a contract major version**, and it is
blocking for a pilot.

## How this is prevented from recurring

Both tiers now test against one generated artifact,
`reconciliation/notification-catalog.json`:

- The **backend** generates it and asserts every transition emits only
  server-generated catalog types.
- The **mobile client** asserts the server carries exactly its own types, that
  categories agree, that `requiresAction` agrees, and — the one that already
  caught a real defect — **that every deep link is a route it actually has**.

Two catalog entries had pointed at `/applications/:applicationId/documents`, a
route the app has never had. Tapping either would have done nothing. That is a
failure nobody files a bug for; they just stop trusting notifications.

## The general lesson

TAB 01's reconciliation compared what both tiers *had*. It did not ask what one
tier had that the other lacked a representation for — and that gap is exactly
where a second vocabulary gets invented. **A concept present in one tier and
absent from the wire is not "reconciled"; it is unexamined.**
