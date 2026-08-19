# ADR 0008 — Appointment booking is out of scope for filing

**Status:** Accepted
**Date:** 19 August 2026
**Decides:** Master Command decision **E-11** (manual task M-24).

## Context

QC e-Services treats a confirmed online appointment as the *first* basic
requirement for a building permit application. The Master Command asks whether
this LGU does the same, and notes that if so it belongs in the lifecycle.

## Decision

**No appointment gate on filing.** Not built, and deliberately not designed for.

## Reasoning

The purpose of eBPCO is that an applicant does **not** come in to file. RA
11032's zero-contact policy exists to remove the counter from the transaction,
and Amended JMC 2021-01 mandates electronic processing. An appointment gate in
front of filing reintroduces exactly the queue the system was built to remove,
and it makes the earliest step the one most likely to fail for reasons unrelated
to the permit — slots, capacity, transport, a missed morning.

QC's model is a reasonable answer to a different question: it schedules a
physical visit that its process still requires. If this LGU's process requires
one, the appointment belongs against **that visit**, not against filing.

There is one place an appointment is genuinely useful here, and it is at the
other end: **claiming the permit**. `permit_releases` already records claim
location, office hours and what to bring, and an applicant who must appear in
person to collect a legal instrument benefits from a slot. That is a much
smaller feature, it does not gate anything, and it belongs with release.

## What this decision does not foreclose

Nothing in the lifecycle prevents an appointment being added later:

- A filing gate would be a precondition on `Draft → Submitted`, alongside
  `identity-document-verified`. The engine's preconditions are declared data;
  adding one is a row, not a redesign.
- A release appointment is a record hanging off `permit_releases` and a
  notification type, neither of which disturbs the state machine.

So the cost of being wrong is bounded, and that is why this is decided now
rather than deferred.

## Consequences

- **M-24 is closed as "decided out of scope"**, not as "built". If the LGU says
  its process requires an appointment before filing, this reverses, and the
  implementation is one precondition plus a booking service.
- The release-side appointment is **not** built either, and is recorded as a
  candidate for TAB 08 rather than silently dropped.
- **The LGU must confirm.** This is an engineering reading of the LGU's own
  process, and the LGU is the authority on what its process is.
