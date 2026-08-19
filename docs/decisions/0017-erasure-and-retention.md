# ADR 0017 — Erasure where two laws disagree

**Status:** Accepted
**Date:** 20 August 2026
**TAB:** 17. Addresses M-15 in part; the retention *period* remains the LGU's.

## The conflict

RA 10173 §16(e) gives a data subject the right to have their personal data
erased. PD 1096 and the LGU's records schedule require a building permit record
to be kept — a permit is evidence that a structure was lawfully authorised, and
it outlives the applicant's relationship with the LGU by decades.

Both are true. There are two ways of pretending otherwise and both are wrong:
delete the permit record on request, and the LGU cannot show a structure was
ever authorised; refuse every request because "we keep records", and the right
is hollow. §16(e) is itself conditional on there being no overriding legal
obligation, so **naming the obligation is what makes the retention lawful**
rather than merely convenient.

## The register comes first

`domain/personal-data.ts` classifies **every column in the database** — 253 of
them across 34 tables — as `direct`, `linkable`, `secret`, `content` or `none`,
each with a retention class and, where it is about a person, a lawful basis.

The classification matters less than the **completeness**. A test reads the live
schema and fails if any column is in neither list, so a new column must be
classified to merge. Without that, "we tagged the personal data" means "we
tagged the personal data we thought of", and the difference is invisible until a
breach notification has to enumerate what was disclosed. Proved by adding an
unclassified column and watching it fail.

`linkable` is the class people forget. An account id identifies nobody on its
own and ties every record here to one person — so erasing a name while keeping
the id everywhere leaves a fully linkable trail and an erasure that did not
erase.

## The account row is pseudonymised, not deleted

This is the decision, and it is a decision rather than a shortcut. Deleting the
row would break one of the two things the erasure exists to preserve:

- **The audit chain hashes `actor_account_id` into every entry.** Nulling it
  invalidates every entry after it — so the erasure would destroy the very
  evidence that the erasure was carried out.
- **The permit record attributes each act to an account**: who uploaded a
  document, who submitted a payment. Dropping those references leaves a record
  that cannot say who did what.

So the row survives as an opaque key holding nothing: email replaced with
`erased-<id>@erased.invalid` (RFC 2606 reserves `.invalid` precisely so a
placeholder cannot collide or be delivered to), mobile null, TOTP null,
verifier replaced with a value that is not a verifier, account disabled.

Calling that "deletion" would be dishonest. What makes it a real erasure is that
**migration 011 enforces it with a CHECK constraint** — an account marked erased
*cannot* still hold contact details, whatever writes to it, including a future
migration or a bug in this service. A service can promise; a constraint holds.

## What else was decided

**Staff accounts cannot be erased on request** (403). An officer's account
attributes decisions on permit records; removing it would make the record unable
to say who approved what, which is the LGU's obligation rather than the
officer's choice.

**Erasure is idempotent.** Asking twice returns the same receipt. Someone asking
again is asking for reassurance.

**`until` is null on every retained category.** The retention schedule is the
LGU's to publish (M-15). A plausible date invented here is a commitment made on
their behalf that an applicant might rely on. Null with a named basis is the
honest answer — "for as long as this instrument requires", not "for ever" and
not "until a date we made up".

**The receipt names no tables.** Row counts are evidence for the LGU; the
applicant gets categories in words.

## Retention was measuring the wrong thing

`runRetention` deleted documents older than N days **from upload**. Under that
rule, the plans on an application still under evaluation vanish the moment they
age past the window: the applicant is asked to resubmit documents the LGU itself
threw away, and the evaluation record points at files that no longer exist.

It now measures from **when the application closed**, read from the closing
transition rather than from `updated_at`, which moves for unrelated reasons. An
application that has not reached a terminal status is never touched, however old
its documents are — there is no retention period for a matter still in progress.

It also reports `skippedOpen`. "Deleted 0" on a system full of old files reads
like a broken job; an operator needs to know documents were held back and why.

## What this does NOT do

- **Nothing schedules retention.** `runRetention` has no caller: no cron, no
  route, no worker. It is correct and it has never run in anger. Scheduling it
  needs the LGU's period (M-15) and a decision about where periodic work runs,
  which is part of the undecided hosting question (E-1).
- **There is no export implementation.** `POST /me/export` is in the contract
  and is not built. The register is what an export would have to be generated
  from, so it is now possible rather than done.
- **The audit chain is never verified on a schedule.** `AuditService.verify()`
  exists and nothing calls it. A tamper-evident log nobody checks is a log.
- **`idempotency_keys`, expired `refresh_tokens` and used
  `password_reset_tickets` are classified `operational` and nothing purges
  them.** They are erased with an account, but they accumulate for accounts that
  are not.
- **No privacy notice, no DPO contact** (M-03, M-16). The controls exist; the
  text a person reads before consenting does not, and that needs counsel.
