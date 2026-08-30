# ADR 0013 — Never assert a pledge the LGU has not made

**Status:** Accepted
**Date:** 19 August 2026

## The governing rule

RA 11032 obliges the LGU to publish processing periods and be measured against
them; ARTA does the measuring. Everything in the pledge clock follows from one
rule:

> **Never assert a pledge the LGU has not made, and never accuse it of lateness
> it has not incurred.**

That rule decides every awkward case, and each decision goes the same way:

| Situation | What a naive clock does | What this does |
|---|---|---|
| No Citizen's Charter entry | Defaults to some period | **No countdown at all.** The clients say "Awaiting classification". |
| Holiday calendar incomplete for the span | Computes a date and asserts it | Computes it and flags it **approximate**; **never** calls the LGU overdue on it |
| Applicant sat on a Letter of Instruction for a month | Counts it | **Excludes it.** RA 11032 excludes it, and counting it attributes the applicant's delay to the LGU |
| Nothing measurable in a reporting period | 100% compliance | **Null.** A rate over zero applications reads as perfect |

The last row is the one most likely to be "fixed" by someone later. It should
not be: a compliance report that says 100% because it measured nothing is worse
than one that says it does not know.

## Why the holiday calendar has a completeness flag

Philippine regular and special non-working days are proclaimed annually, and the
movable Islamic holidays — Eidul Fitr and Eidul Adha — are proclaimed **during**
the year (M-12). A period computed before those land can be short by up to two
working days.

Being short means the LGU appears late when it is not. So a span touching any
year without a full proclamation yields `approximate: true`, and `overdue` is
hard-wired to false whenever `approximate` is true. The compliance report puts
those applications in an `indeterminate` column and counts them in neither
direction.

## The audit chain, and what it is not

Each entry commits to the one before it, so removing or editing a row breaks
every row after it and one pass detects it. Appends are serialised through a
locked chain-head row, because two concurrent appends claiming the same
predecessor is indistinguishable from a forgery.

**It is not tamper-proof, and is not claimed to be.** Someone with database
superuser rights can recompute the whole chain, and no in-database scheme can
prevent that — write-once storage or an external anchor is what would. What this
achieves is raising tampering from one UPDATE, which nobody would notice, to
rewriting every row since, which is a different kind of act and leaves different
evidence. The tests demonstrate detection by disabling the append-only trigger
first, which is exactly what a superuser bypassing it would have to do.

Coverage is wider than mutations: NPC Circular 16-01 expects a government agency
to account for who **viewed** personal data, so a document read and a
personal-data export are audited in their own right, as is a refused
authorisation — an attempt to reach another applicant's record is precisely what
anyone investigating an incident wants to find.

## What remains open

- **E-3 / M-08.** `charter_entries` is empty, so today every application is
  `unclassified` and the report measures nothing. That is the correct behaviour
  and a real blocker: the clock cannot start until the LGU supplies its charter.
- **Write-once storage or an external anchor** for the audit trail, if the LGU's
  threat model includes a compromised database administrator. TAB 14 should ask.
- **The report is computed on demand.** At volume it wants materialising; that
  is TAB 16's call, on measurement rather than guesswork.
