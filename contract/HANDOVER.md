# Handover to the contract repository

**As at 24 August 2026**, backend `b74ac15`.

The backend emits its evidence into this directory rather than into
`ebpco-contract`, so this file is the difference between what the server now
sends and what the contract currently declares. It was produced by running the
contract repository's **own** validators against these files in a throwaway
copy — no tooling was duplicated and nothing in that checkout was touched.

## Taking the files

```
cd ebpco-api
npm run emit:samples -- ../ebpco-contract/reconciliation
```

That writes `response-samples.json` and `route-table.json`. Then run
`./tools/verify.sh` in the contract repository. **It will fail on seven things
until the changes below are made** — every one of them the contract catching up
with a real change, not a defect.

## What the gate will say, and what to do about it

### 1–4. `StaffApplicationDetail` is missing two fields

```
staff.applications.detail: unexpected property 'form'
staff.applications.detail: unexpected property 'formValidatedAgainst'
staff.applications.detail.complete: ... (the same two)
```

An application now carries the applicant's own answers — the fifteen or more
screens of the permit wizard. Until recently `form` was accepted by the
submission endpoint, parsed, and **discarded**; an officer opening an
application saw a permit type, a location and a stack of documents, and none of
what the applicant had written.

Add to `StaffApplicationDetail`:

| Field | Type | Notes |
|---|---|---|
| `form` | `object`, `additionalProperties: true` | The applicant's answers. Structurally bounded on the way in — 256KB, 8 levels, 500 fields, 8000 characters per value — and semantically unchecked. |
| `formValidatedAgainst` | `string` \| `null` | Which form schema accepted it. **Null on every application today**, and that is the honest state: the unified DPWH/JMC forms have not been supplied (M-10), so no permit type has a field set to check against. Recording it as a column rather than assuming it makes the gap queryable when they arrive. |

`ApplicantApplication` also carries `form` now, deliberately: an applicant who
has to reopen a filing to check what they put in a field, and cannot, will file
again rather than trust it. It does **not** carry `formValidatedAgainst` —
whether the LGU had a schema is an operational fact about the LGU, not something
an applicant can act on, and showing it invites "so nobody checked my
application?"

### 5–7. Three paths the contract does not describe

| Path | What it is |
|---|---|
| `POST /staff/applications/{applicationId}/onsite-payment` | A cashier recording a walk-in payment. Needed its own route because the applicant's proof endpoint records the **applicant** as submitter, and pointing a cashier at it would let one officer both record and verify the same money. |
| `GET /me/export/{requestId}` | Where a data-portability request has got to. |
| `GET /me/export/{requestId}/content` | A short-lived link to the produced file. |

`POST /me/export` was already declared and is now implemented.

**On the export status endpoint:** the contract says of `/me/export` that "the
feed carries the result". It does not, and the backend does not pretend
otherwise. Emitting a notification needs a catalog type the mobile client can
parse, its enum parser **throws** on an unknown type, and the nearest existing
type (`account-update`) deep-links to `/applications/:applicationId` — which an
export does not have. A notice with a dead link is worse than none. That is why
there is a status endpoint to poll, and closing the gap properly needs a catalog
entry only the mobile lane can add.

## Something the gate did NOT catch, and probably should

`ApplicantApplication` accepted `form` **silently**. It is an `allOf` with no
`additionalProperties: false`, so it is permissive; `StaffApplicationDetail` is
closed and caught it immediately.

That matters more than one missing field. The contract says of these two
schemas that "the two views are separate schemas rather than one schema with
optional fields, so a server bug cannot leak an officer-only field to an
applicant". **On the applicant side that guarantee is currently not enforced** —
a field appearing in an applicant payload that should not be there would pass
the gate without comment. Closing `ApplicantApplication` (and
`ApplicationCore`, which it composes) would make the stated property real.

Worth checking the other applicant-facing schemas for the same thing while you
are in there.

## What has NOT changed

- **Client alignment still passes**: all 25 endpoints the two clients call are
  reachable, against 45 registered routes.
- **No enum, status vocabulary or lifecycle value has moved.**
- **13 contract checks and the 12 client-alignment checks pass unchanged.**

## Why the ids and timestamps look fixed

`stabilise` replaces them so a diff shows a shape change and nothing else —
every regeneration used to rewrite all of them, and one real line among eighty
noisy ones teaches a reviewer to skim. **A value is only replaced if it was
already valid**, so a malformed timestamp still reaches your validator and still
fails. See `contract/README.md`.
