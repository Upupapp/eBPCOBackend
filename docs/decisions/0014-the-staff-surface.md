# ADR 0014 — The officer's surface, and what an officer may count

**Status:** Accepted
**Date:** 19 August 2026
**TAB:** 13. Closes the server half of gap G3.

## What was actually missing

TAB 13 was written as "replace the admin's in-memory store". It could not be
done as written, and the reason is worth recording plainly: **there was nothing
to replace it with.**

- The contract described 42 operations, every one of them applicant-facing.
  There was no staff surface at all — no queue, no transition endpoint, no
  dashboard, no way for an officer to read an application.
- The backend had the domain: a lifecycle engine, a pledge clock, an assessment
  service, a payment service, an audit chain — roughly seven hundred passing
  tests. Over HTTP it exposed eleven routes: `auth/*`, `/me`, and the health
  probes. **None of the domain was reachable.**

So this ADR is about the layer that had to exist first.

## The fix that was rejected

Persisting the admin's store to `localStorage` would have stopped the data loss
in an afternoon. It is the wrong fix, and shipping it would have been worse than
leaving the defect visible.

An evaluation is not a note the officer made to themselves. The cashier at the
next desk has to see it, and the applicant has to be told. State that survives a
refresh but never leaves one browser looks like a working system and behaves
like a filing cabinet nobody else can open — and it would have taken the
pressure off building the thing that actually fixes it.

## The decisions

**Aggregation belongs in SQL, not in the browser.** The admin computed every KPI
by filtering an in-memory array of all applications. That is two defects wearing
one coat. It does not scale — forty rows is fine, forty thousand is not — and it
means every officer's browser is sent every applicant's business name, address
and permit history regardless of role. `metrics()` returns scalars the database
counted. A count is the one shape that can be computed over a row without
disclosing it.

**Visibility is a row filter, not a UI decision.** A cashier has no reason to
read an application that has not reached assessment; a releasing officer has
none until it is approved. Hiding those in the client still sends them. The
`SCOPE_VISIBILITY` table refuses to select them, roles that legitimately see the
whole pipeline are listed explicitly, and a requested status filter narrows
within that clause and can never widen it — there is a test that tries.

**Not-yours and not-there answer the same way.** Telling a cashier that
reference BP-2026-000412 exists but is not theirs to open confirms that a
neighbour has applied for a building permit. `detail()` returns null for both.

**Drafts are invisible to everyone.** A draft is the applicant's private working
copy. Nothing has been filed, so nobody at the LGU may read it.

**Keyset paging, not OFFSET.** An officer working a queue changes the rows that
order it. With OFFSET, a row moving to the front shifts every later row down:
the next page repeats one application and drops another, and the dropped one is
never opened by anyone. The property keyset gives is stated exactly in the test —
no row twice, and no untouched row missed. A row that *moves* is now at the top
of the queue, which is where the officer will meet it.

**One request returns one application whole.** The alternative — the client
fetching seven collections and stitching them — is what the in-memory admin did
with seven signals, and it produces a screen where the documents belong to this
application and the payment does not, because one request failed and nothing
noticed.

**A refusal keeps its kind.** "You may not do this" (403), "this application is
not in a state for that" (409), "you have not paid yet" (422) and "someone else
changed it while you were reading" (412) need four different next actions from
the officer at the counter. Collapsing them into one 400 makes all four look
like a bug in the app. The wording comes from the domain's own
`PRECONDITION_MESSAGE` table rather than from strings in the controller: a
second wording of "you have not paid yet" is a second thing to keep in step, and
the one that drifts is always the one the applicant reads.

## The pledge, and a correction

The first version of the queue computed "days remaining" as
`submitted_at + n days`. That is a second, wrong implementation of RA 11032. It
counts weekends and proclaimed holidays as working days and ignores the
applicant's own suspension, so it reports breaches that did not happen. It was
replaced with the compliance module's `computePledge` — the same clock the
compliance report uses — and `SqlCalendarRepository` was written because
nothing had yet loaded the two holiday tables into the shape that clock takes.

That correction surfaced a second error, in a metric of my own design. I had
planned `overdueApproximate: boolean` — "this overdue count rests on a year not
yet proclaimed in full". It can never be true. `computePledge` deliberately
returns `overdue: !approximate && remaining < 0`: it will not call an LGU late
on a date that could still move (M-12). So "overdue" and "approximate" are
mutually exclusive by construction, and the flag was unreachable.

The honest shape is two numbers. `overduePledge` is asserted, on a fully
proclaimed calendar. `pledgeIndeterminate` counts applications whose pledged
days have run out as the calendar stands but where a holiday still to be
declared could move the deadline — worth an officer's attention, not worth an
accusation.

Overdue is computed over the **open set only**. That set is bounded, so one
number does not require loading every application ever filed; and it is the only
set where the answer is actionable. Whether a permit released last March met its
pledge is a question for the compliance report, which measures a period rather
than a moment.

## What this does NOT do

- **The admin still holds its state in memory.** The server half exists and is
  tested; the Angular migration is the other half and is deliberately a separate
  change. G3 is not closed until it lands.
- **No staff endpoints for evaluations, assessments, permit generation or
  release.** Those services exist and are tested; they are not yet routed. The
  transition endpoint is the one the queue needs first, because it is the one
  every other action depends on.
- **The contract does not describe any of this yet.** These paths are real and
  the OpenAPI document does not mention them, which is exactly the divergence
  `ebpco-contract` exists to catch. Adding them is the next piece of work.
- **An access token whose account has since been deleted produces a 500**, not a
  401 — the foreign key on `application_transitions` refuses the audit row, and
  rightly, but the failure arrives too late to be reported well. Found by a test
  fixture that invented an officer. Recorded rather than fixed here: the correct
  answer is either revocation on deletion or an existence check in the guard,
  and that is an authentication decision, not a queue one.
