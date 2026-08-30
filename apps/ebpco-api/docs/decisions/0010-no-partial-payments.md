# ADR 0010 — An Order of Payment is settled in full, or not at all

**Status:** Accepted
**Date:** 19 August 2026
**Decides:** Master Command decision **E-8**.

## Context

May an Order of Payment be settled in parts? The Master Command notes it
"changes the payment model and the lifecycle", and that it is "cheap to decide
now, expensive to retrofit".

## Decision

**No.** A payment either settles its Order exactly or it does not settle it.
There is no balance, no part-payment state, and no derived remainder.

## Reasoning

**The lifecycle has no half-paid state, and adding one is not free.** It would
mean a twentieth value in a nineteen-value vocabulary that TAB 01 reconciled
across both clients and pinned in the contract, the database, and a test in the
mobile app. Adding an enum value is a *breaking* contract change by design,
because clients reject unknown values rather than defaulting. That cost should
buy something real.

**The Treasury issues one Official Receipt per Order.** Reconciliation matches
receipts to payments (TAB 07). A partial payment produces a receipt for an
amount that does not match the Order it settles, and the reconciliation report
would show a discrepancy on every correctly-handled instalment — which trains
whoever reads it to ignore discrepancies.

**The real need has a better answer.** Where a fee is genuinely too large to pay
at once, the LGU issues **separate Orders** for separable components — filing
now, construction fees on approval. That is already supported: each Order is its
own record with its own number, its own receipt, and its own reconciliation row.
It is also more honest, because the components are separately assessed and
separately owed rather than one debt paid in arbitrary pieces.

## What this does NOT mean

It does not mean an amount that differs is rejected automatically.
`checkSettles` reports `underpaid` or `overpaid` **to the officer**, with the
difference, and stops there:

- Someone who paid PHP 6,819.99 against PHP 6,820.00 has made a mistake worth a
  conversation, not an automatic refusal — bank charges are sometimes deducted
  from the transfer, and that is not the applicant's error.
- Someone who overpaid is owed a refund, which is a Treasury process.

Neither is something software should settle on its own, and the officer needs
the figure in front of them to decide. Nor does it mean one attempt only: a
rejected payment can be resubmitted, and an application may carry several
attempts. A unique index ensures only one may ever be *verified*.

## Consequences

- `balanceCentavos` in the contract stays absent rather than always-null. It was
  specified as present "only if partial settlement is permitted", and it is not.
- If the LGU reverses this, the change is a new lifecycle status, a contract
  major version, a schema migration, and updates to both clients. That is the
  retrofit cost the Master Command warned about, and it is why this is decided
  now.
- **The LGU must confirm.** How its Treasury accepts money is the LGU's process,
  not an engineering choice, and this is implemented as the reading that keeps
  reconciliation meaningful.
