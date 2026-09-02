# F-32 — the officer's own name, and the third axis of access

Raised by the admin portal lane. Two omissions on `GET /me`, each of which left
something already built sitting inert.

## The name was never missing — it was thrown away

Every officer saw their own **email address** in the portal's topbar, because
`GET /me` returned no name for a staff account.

The cause is not that nobody asked for it. `access_requests.full_name`
(migration 032) collects the officer's name at sign-up, the pending queue shows
it to the super admin, and the approver reads it before deciding. Then
`approve()` created the account and **dropped the name in the same transaction**,
because `accounts` had nowhere to put it.

Migration 034 adds `accounts.full_name`, `approve()` carries it across, and the
backfill **recovers the names already collected** — matched on the normalised
email, which is the same value the approval used to create the account, so it is
the same identity rather than a fuzzy match. Only `approved` requests: a pending
one names somebody with no account, and a rejected one names somebody the office
declined.

**One field, not two.** `applicants` splits first and last name; this does not,
because what is collected is a single full name, and splitting it here would be
a guess. Philippine names routinely carry two given names and a maternal
surname, so "first token, last token" produces a wrong name for exactly the
people whose names are least like the developer's. The admin lane asked for
`firstName`/`lastName`; it gets `fullName`, and changing what the sign-up form
collects is the only honest route to the split.

**Null stays possible and means "not recorded".** A staff account created before
the access-request flow — the seeded super admin among them — genuinely has no
name. Inventing one would be worse than the email the portal shows today.

## The third axis was invisible

The access model has three axes: **role**, **level**, and **the permit types an
officer may work on**. `GET /me` reported roles and scopes only.

Scopes do encode the level — a view-only officer's token is issued without the
authority scopes — but **nothing encoded the forms**. So a portal could not tell
which permit types to offer, and three built screens had nothing to drive them.

`/me` now returns `level` and `permitTypes` for staff, read through
`liveAccessFor` rather than `accessFor`: a retired permit type is excluded,
because a screen must not offer something nobody can file against today. The
grant itself survives underneath — it is how an officer's historical work stays
attributable — so this is a display rule, not a revocation, and a test asserts
both halves.

An applicant gets none of these three fields. They are meaningless for that kind
of account and their presence would imply one the holder does not have.

## `serviceDomain`, which the server knew and would not say

Not asked for, and closes a hand-rolled rule the admin lane had to write.

The portal's permit-type union holds the office's nineteen names. `Business
Permit` is a legitimate twentieth the server accepts, so it failed the client's
validation, `permitType` came through null, and **every legacy application
rendered "Not recorded"** — which was false: the type was recorded, the client
simply does not publish that name. Their fix was to carry it separately and mark
it "not an office permit".

The server already held the answer and was not sending it. `permit_types
.service_domain` is `'Construction Permit'` for the nineteen and `'Business
Permit'` for the twentieth. It is now on the staff queue rows.

This matters beyond one value: a client hard-coding "Business Permit is not an
office permit" breaks the next time the LGU adds a non-construction permit type.
`serviceDomain` does not.

## A constraint on retiring `permitTypeName`

The admin lane reads `permitTypeName` **before** `permitType`, because a
deployment running the older server sends the two apart. Dropping the field
without notice would silently put them back on the pre-D-10 path.

So `permitTypeName` is not to be removed on this lane's judgement alone. It is
redundant, and it stays until the admin, mobile and citizen-web lanes have each
confirmed they no longer read it.

## Corrections to what this lane told the admin portal

* I said the three permits another office issues — Zoning / Locational
  Clearance, FSEC, FSIC — were new to the admin portal. **They were not.** All
  three have always been in its nineteen; they were new *server-side* only. The
  evidence was already in this repository: `contract/permit-vocabulary.json`
  pins all nineteen from the admin's own domain model.
* I described `Business Permit` as a footnote. **It was the item that actually
  bit them**, and the one worth leading with.
* I suggested removing an `as` cast. There was none — their
  `publishedPermitType` always validated against the union rather than casting
  into it.

Gate: 82 suites, sample coverage unchanged (`serviceDomain` is an added field on
existing samples, not a new route).
