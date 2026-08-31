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

---

## D-10 — an MFA-required role locks the account out permanently

**Severity: any account created with one of six roles can never sign in.**

Found seeding the first super admin, and it is not specific to seeding.

`MFA_REQUIRED_ROLES` holds `assessor`, `cashier`, `building-official`,
`releasing-officer`, `administrator` and `super-admin`. At sign-in:

```ts
if (requiresMfa(account)) {
  if (totp === undefined) return { ok: false, reason: 'mfa-required' };
  if (!await this.verifyTotp(account, totp)) { ... return rejected; }
}

private async verifyTotp(account: Account, presented: string): Promise<boolean> {
  if (account.totpSecret === null) return false;   // ← never enrolled
  ...
}
```

An account holding such a role and no enrolled secret is refused
**unconditionally**. And enrolling one is unreachable:

- `POST /me/mfa/enrol` needs a session.
- A session comes from `/auth/token` — blocked by the above — or
  `/auth/token/refresh`, which needs a refresh token nobody can obtain.
- `POST /auth/password/reset` returns **204 and issues no session**, so the
  recovery flow does not open a window either.

**`POST /staff/users` creates exactly these accounts.** An administrator adding
another administrator produces an account that is locked out from the moment it
exists, and nothing in the response says so — it reports the officer should set
a password through account recovery, which they can do, and it will not help.

### CORRECTION to this finding, 2026-08-31

The first version of D-10 above said the only working path was "create the
account with a non-MFA role, sign in, enrol, then grant the MFA-required role".
That was written without reading `test/mfa.e2e-spec.ts`, which states the actual
design:

> an account with no factor still signs in far enough to enrol when its role
> does not require one, and **an MFA role is enrolled by an administrator
> resetting it or at first issue**

So the lockout is deliberate, and it holds a property worth keeping — stated in
`identity.service.spec.ts`: *"A staff member cannot disable their own MFA by
clearing the secret — that path fails closed."*

**A first attempt at fixing this gave unenrolled accounts an enrolment-only
session. Two committed tests failed, correctly: that change would have undone
the property above.** It was reverted.

The real gap is narrower. The staff directory REPORTS `mfaRequired` and
`mfaEnrolled` for every account — so an administrator could see an officer was
stuck — and there was **no route to act on it**. The reporting existed; the
action did not.

**Fixed** by `POST /staff/users/:userId/mfa/reissue` (`staff:administer`): the
administrator clears the old factor, a new one is generated and activated, and
the provisioning URI is returned ONCE to hand over out of band. It refuses an
administrator re-issuing their own factor — that is the self-service path this
avoids, since anyone holding a session could otherwise replace the second factor
protecting it.

### The path that was assumed and never built

Create the account with a role that does NOT require MFA, sign in, enrol through
`/me/mfa`, then grant the MFA-required role with `PATCH /staff/users/:id`. That
ordering is undocumented and is the opposite of what `POST /staff/users` invites.

### Why nothing caught it

The e2e suites issue staff tokens through `TokenService` directly rather than
through `/auth/token`, so no test has ever signed a staff account in through the
password path. `test/mfa.e2e-spec.ts` covers enrolment for an account that can
already authenticate. The gap is the FIRST sign-in of an MFA-required account,
which no test performs and every real officer must.

### Fix, in preference order

~~1. Require MFA only once enrolled…~~ **Rejected**: it undoes the
   cannot-disable-your-own-MFA property, and two committed tests say so.

2. **Done** — the administrator re-issue route above. `POST /staff/users` should
   additionally return an enrolment URI at first issue, so a new officer is
   never created stuck; that remains open.

`scripts/seed-super-admin.ts` works around it by completing the enrolment
itself: it generates the secret through the same `TotpService`, computes the
current code, activates, and prints the `otpauth://` URI once. That is correct
for a bootstrap and is not a fix for the six roles above.

### A property worth documenting either way

`activate` stamps `totp_last_step`, and `verifyAtSignIn` refuses that step or
earlier. The code used to enrol is therefore already spent, and the first
sign-in must use the NEXT one. Presented too early it returns
"Those credentials were not accepted", which reads as a wrong password.
