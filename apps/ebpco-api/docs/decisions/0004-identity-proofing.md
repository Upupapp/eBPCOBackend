# ADR 0004 — Identity proofing: tiered, matching what the counter already does

**Status:** Accepted
**Date:** 19 August 2026
**Decides:** Master Command decision **E-5**.

## Context

How is an applicant proven to be who they claim? The answer sets the legal
weight of an electronic filing under RA 8792 and the fraud exposure the LGU
accepts. A building permit is consequential: one filed fraudulently against
someone else's title is a real harm to a real person.

The Master Command lists the range as "email verification, in-person
verification, or PhilSys".

## Options considered

| Option | For | Against |
|---|---|---|
| Email verification only | Frictionless. | An email address proves control of an inbox, nothing more. Too weak to stand behind a permit. |
| PhilSys (RA 11055) | Strongest attribution available in the Philippines. | Excludes anyone not yet registered — and the people least likely to be registered are the ones least able to absorb being excluded. RA 11055 also constrains how PhilSys data may be used and retained, adding a compliance surface for every applicant. Makes the LGU dependent on a national system's availability. |
| In-person verification before filing | Strong. | Defeats the purpose. RA 11032's zero-contact policy and the whole point of an e-permitting system is that the applicant does not have to come in to start. |
| **Tiered** | Strength where the consequence is. | More moving parts to explain. |

## Decision

**Three tiers, each placed where the consequence actually sits.**

1. **Account (verified email + verified PH mobile).** Enough to register, browse
   the catalog, save drafts. Two independent channels, so a compromised inbox is
   not sufficient on its own.
2. **Filing (identity document, verified by the OBO).** A government-issued ID is
   already on the requirements list for every permit type. It is verified by a
   human during Document Verification — a step that already exists in the
   lifecycle. No new process; the check that was always there is simply the one
   that carries the attribution weight.
3. **Release (in-person ID at claim).** Already the LGU's practice, and unchanged.
   `PermitReleaseRecord` already records claimant and release method.

## Why this and not PhilSys

The strongest identity check belongs where the strongest consequence is, and for
a building permit that is **release**, not registration. A fraudulent filing that
never reaches release costs the LGU review time; a fraudulently *claimed* permit
is a legal instrument in the wrong hands. The LGU already checks ID at that
point, and this decision keeps it there rather than moving the burden to the step
that would exclude people.

PhilSys is not ruled out. It becomes a stronger substitute for tier 2 if the LGU
adopts it, and nothing in this design would have to change to accommodate it —
the tier is "an identity document the OBO verified", and a PhilSys check is one.
It is not made mandatory, because adopting it as the only path would exclude
applicants for a system-availability reason unrelated to their permit.

## RA 8792 attribution

The evidentiary weight of an electronic filing rests on the audit trail (TAB 09),
which records who acted and when, together with the verified identity document on
file and the mobile number that received the sign-in factors. That is a stronger
chain than an unverified email address, and it is assembled from steps the LGU
already performs.

## Consequences

- Email and mobile verification must both exist before any pilot. Mobile
  verification needs an SMS provider — a procurement item, and it overlaps with
  decision **E-9** (escalation channel for statutory notices). They should be
  answered together and probably by the same provider.
- An application cannot leave `Document Verification` without a verified identity
  document. TAB 05 enforces this as a lifecycle precondition, not as a UI rule.
- **This decision must be reviewed by the LGU and by counsel** before real filings
  are accepted. It is an engineering proposal about where to put a legal check,
  and where a legal check goes is not ultimately an engineering call.
