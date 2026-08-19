# ADR 0007 — Applicants may withdraw, until an Order of Payment exists

**Status:** Accepted
**Date:** 19 August 2026
**Decides:** Master Command decision **E-4** (manual task M-14).

## Context

May an applicant cancel their own application? The Master Command flags it as "a
policy question with regulatory consequences, including what happens to fees
already assessed or paid".

## Decision

**Yes, from `Draft`, `Submitted`, `Received` and `Revision Required`.**
**No, from `Assessed` onward.**

The transition `Assessed → Cancelled` remains legal — but staff-only. An
applicant who wants out at that point makes a request an officer decides on.

## Reasoning

Before assessment, nothing has changed hands. Requiring someone to visit an
office to withdraw an application they filed from their phone defeats the
zero-contact policy the whole system exists to serve, and the LGU loses nothing
by letting them: no fee has been assessed, no money has moved, and the
evaluation work already done is sunk either way.

From `Assessed` onward the picture changes, because an Order of Payment exists
and it is an **immutable financial instrument** (ADR 0005 and migration 004).
Cancelling past that point does one of two things, and both are somebody else's
process:

- The applicant has already paid, and cancelling strands their money. Refunding
  it is a Treasury process with its own authorisations, and it is not something
  a mobile app should be able to trigger.
- They have not paid, and the outstanding Order must be formally voided. That is
  an officer's act on a financial record, not a self-service one.

Neither is a reason to trap the applicant. It is a reason for the withdrawal to
become a **request** at that point rather than an action.

## Why this is expressed as a permission, not as a missing transition

`Assessed → Cancelled` stays in the transition table with `actors: ['staff']`.
Removing it would say the move is impossible, which is false — an officer must
be able to close an abandoned assessed application. Keeping it and narrowing who
may make it says the true thing: the move exists, and the applicant is not the
one who makes it.

That distinction is why permission and transition are separate dimensions in the
engine, and why the refusal an applicant gets is `not-permitted` rather than
`illegal-transition`.

## Consequences

- The mobile client must show "Request withdrawal" rather than "Cancel" once an
  application is assessed, and must explain why. TAB 10 owns that copy.
- There is no withdrawal-request record yet. Until there is, the applicant's
  route is the support channel, and that is a gap TAB 21 must close before a
  pilot — a screen that says "ask an officer" with no way to ask is worse than
  no screen.
- **This is a policy call with regulatory consequences and must be confirmed by
  the LGU.** It is implemented as the safest default, not as a settled question.
