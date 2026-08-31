# Two defects found by running the server and calling it

Found 2026-08-31, standing up a local instance for the mobile lane. Both were
invisible to 1,621 passing tests, because every one of them is a claim about
this service's own source.

---

## D-9 — a self-registered applicant can never file

**Severity: blocks the entire registration → filing path.**

`POST /auth/register` returns 202 and creates an `accounts` row with
`kind='applicant'`. It does **not** create an `applicants` row.

The first filing then fails:

```
422 {"detail":"This account has no applicant profile. Complete your profile before filing."}
```

And there is no way to fix it from outside the database:

- No route creates an applicant profile. The route table has 91 entries and
  none of them is a profile write.
- `insert into applicants` appears **only in test files**, never in `src/`.
  Every test that files an application seeds the profile itself, which is why
  no test has ever exercised the path a real applicant takes.

`/applications` and `/businesses` both refuse with the same message, so this
blocks both. Registration is not a usable entry point to this service today.

**Why nothing caught it.** The e2e suites construct their fixtures directly:
they insert an account, insert an applicant, and proceed. That is reasonable for
testing a filing, and it means the seam between registration and filing has
never been crossed by anything. The suite is not weak — it is testing a
different question, and no one had asked this one until a client tried to
register.

**Fix.** `IdentityService.register` already receives `firstName`, `lastName` and
`mobileNumber` and validates them; it should write the `applicants` row in the
same transaction as the account. Anything else leaves an account that exists and
cannot act.

---

## D-8 — document resubmission has no endpoint

**Severity: blocks a real applicant journey.**

The mobile client calls
`POST /applications/{id}/documents/{documentId}/resubmit`
(`http_applications_repository.dart:139`). It returns **404**. Nothing
implements it and the contract does not declare it.

What exists is a different operation:
`POST /applications/{id}/instructions/{letterId}/resubmit` — responding to a
Letter of Instruction.

They are not interchangeable. **A document can be rejected with remarks when
there is no Letter of Instruction at all**, and an applicant told "your survey
plan is unsigned" then has nowhere to put the corrected one. A grep for
`resubmit` matches the instruction route and reads as closure, which is why this
survived.

**Fix.** A document-scoped resubmission that replaces one document and records
the replacement, without requiring a letter to hang it from.

---

## Not a defect: account deletion already exists

Reported as a certain App Store rejection under Apple Guideline 5.1.1(v)
— *"The contract has no DELETE operation anywhere."*

`DELETE /me` exists, is implemented, and returned **202** on a live call. It is
the RA 10173 §16(e) right to erasure, requires `profile:write`, and is listed in
`contract/route-table.json` — the routes Fastify actually registers.

If a client's copy of the contract lacks it, that is a contract-sync problem
rather than a missing capability. **5.1.1(v) is satisfiable today.**

---

## Not a defect, but a client fix that would break: `serviceDomain`

The mobile lane fixed six wire defects this week, one being *"serviceDomain was
never sent — a conforming server would have refused every filing."*

Measured against this server, the opposite holds. `submissionShape` is
`.strict()` and does not declare `serviceDomain`:

```
POST /applications  {"permitType":"New Construction","serviceDomain":"Construction Permit",...}
400 {"errors":[{"pointer":"/","message":"Unrecognized key(s) in object: 'serviceDomain'"}]}
```

The field is **derived from `permitType` and returned in the 201 response**. It
is output. Shipping the client-side "fix" would break every filing.

Worth stating plainly because the reasoning that produced it was sound — the
contract types the field, and the client wasn't sending it. What the contract
did not say is which direction it travels.

---

## What the other four fixes actually did

Verified against the running server, not a stub:

| Fix | Verdict |
|---|---|
| `location` now sent | Accepted, stored, echoed |
| `form` now sent | Accepted, echoed intact — the whole object round-trips |
| `Idempotency-Key` now sent | **Required.** Omitting it is a 400. Replaying returns the same `referenceNumber` and creates nothing |
| `GET /applications/{id}` now called | 200, full record including `form` |

Four of six correct, one already satisfied, one actively harmful. That ratio is
the argument for the exercise.
