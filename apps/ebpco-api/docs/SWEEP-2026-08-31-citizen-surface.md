# Citizen surface sweep, for App Store submission

The backend serves three transaction surfaces; two of them — the mobile app and
the business-owner web portal — are **one product for one user type, CITIZEN**,
and must be in parity. This is what that user type can reach today, measured
against the journey an App Store reviewer follows: install, register, file a
permit, and get one.

**91 routes: 51 staff, 40 citizen-reachable.**

## Present and correct

| Need | Route | Note |
|---|---|---|
| Account deletion | `DELETE /me` | **Apple Guideline 5.1.1(v) satisfied.** 202 with `erasedCategories` and `retainedCategories`; retention is named rather than silent |
| Register | `POST /auth/register` | Creates the applicant profile as of D-9; before that the account could never file |
| Sign in / refresh / revoke | `POST /auth/token`, `/refresh`, `/revoke` | MFA is not required of applicants |
| Password recovery | `/auth/password/forgot`, `/reset` | Out of band |
| Contact verification | `/me/contacts/:channel/request`, `/confirm` | |
| Data portability | `POST /me/export` + 2 reads | RA 10173 §18 |
| What a permit requires | `GET /requirements/:permitType` | |
| File | `POST /applications` | Idempotency-Key required |
| Track | `GET /applications`, `/:id`, `/:id/timeline` | Detail carries the pledge clock and the full fee breakdown |
| Withdraw | `POST /applications/:id/cancel` | |
| Respond to a Letter of Instruction | `POST /applications/:id/instructions/:letterId/resubmit` | |
| Upload | `POST /documents` | |
| Pay | `POST /applications/:id/payments` | |
| Notifications | list, read, resolve, preferences | |
| Push | `POST /devices`, `DELETE /devices/:id` | |

## C-1 — the issued permit cannot be obtained. BLOCKING.

**The app exists to get a citizen a building permit, and there is no endpoint
that returns one.**

`generated_permits` holds `permit_number`, `issued_date`, `scope` and
`conditions`. It is written by `PermitService`, read by `PaymentService` and by
the data-export service — and **by no controller**. A citizen who files, pays,
and is approved has no way to learn their permit number, and no way to obtain
the permit itself.

The applicant projection in `applicant-query.service.ts` carries
`lifecycleStatus`, the pledge dates, the order of payment and the fee
breakdown. It carries **no permit number and no document reference**.

The only path to it today is `POST /me/export` — the RA 10173 data export. That
is a compliance mechanism, not a product feature: it returns the subject's whole
record as a file, asynchronously, for a privacy request.

A reviewer following the app's own description reaches "Permit Generated" and
stops. Recommend: `GET /applications/:id/permit`, returning the number, issue
date, scope and conditions, plus a link to the document.

## C-2 — a citizen cannot see the documents on their own application. BLOCKING.

`POST /documents` uploads one. `GET /documents/:documentId/content` returns
one's bytes. **Nothing returns the list**, and the application detail has no
`documents` field — 0 occurrences of the word in the applicant projection.

So there is no way for the app to show:

- which documents were uploaded,
- which were **rejected, and why**,
- which are still missing.

The client cannot discover a `documentId` at all, so `GET /documents/:id/content`
is unreachable except for an id the app happened to keep from its own upload
response. Rejection remarks — which the staff side writes — never reach the
person who has to act on them.

This is what makes **D-8** worse than it looks: the resubmit endpoint is missing
AND the citizen cannot see that a document needs resubmitting.

## C-3 — no rectification of personal data. RA 10173 §16(d).

There is no `PUT` or `PATCH` on `/me`, and none on `/businesses`.

A citizen who mistypes their surname or changes their mobile number cannot
correct it. The Act gives a data subject the right to **"dispute the inaccuracy
or error in the personal information and have the personal information
controller correct it immediately"**. The controller currently cannot, through
any interface the subject can reach.

The data is not immutable by design — `applicants.first_name`, `last_name` and
`accounts.mobile_number` are ordinary columns, and the staff directory updates
staff records. The route was simply never built.

## C-4 — no payment history or receipt

`POST /applications/:id/payments` submits one. Nothing lists them. The detail
exposes `paymentSubmittedAt` and `paymentVerifiedAt` — two timestamps — so a
citizen who paid can see *that* it was verified and never what they paid, when,
by what method, or under which reference. There is no receipt.

## C-5 — businesses are write-once

`GET /businesses` and `POST /businesses` exist; there is no update and no
delete. A business registered with a typo is permanent, and every future
application inherits it.

## Already filed

- **D-8** — `POST /applications/:id/documents/:documentId/resubmit` returns 404.
  The mobile client calls it.
- **serviceDomain is server-derived output**, not client input. The submission
  shape is `.strict()`; sending it is a 400. A client "fix" that adds it breaks
  every filing.

## What this means for submission

C-1 and C-2 are the two that would fail a review on the app's own terms rather
than on a guideline: the product cannot deliver the thing it is for, and cannot
show a citizen why their application is stuck. Both are read-side additions over
data that already exists — no schema change, no lifecycle change.

C-3 is a legal obligation rather than a store requirement, and is cheap.

Nothing here is a defect in what the backend *does*. Every one is a projection
that was never exposed: the permit is generated, the documents are reviewed, the
payments are recorded, and the names are stored. The write side is complete and
the read side stops short of the citizen.
