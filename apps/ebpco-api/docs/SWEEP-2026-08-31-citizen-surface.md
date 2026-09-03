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

## C-1 — the issued permit cannot be obtained. BLOCKING. — CLOSED d4d2606

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

## C-2 — a citizen cannot see the documents on their own application. BLOCKING. — CLOSED, see below

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


---

## C-1 CLOSED — `GET /applications/:applicationId/permit`

Shipped at `d4d2606`. A citizen can now read the permit they were issued: the
number, the issue date, the scope, the conditions, and whether it can be
collected yet.

**What is returned.** `permitNumber`, `issuedDate`, `scope`, `conditions[]`, and
`release` (`status`, `method`, `releasedAt`) — or `release: null` when no officer
has prepared it. Null rather than absent: "not ready" is a fact the applicant
should read, not infer from a missing key.

The `conditions` array is the part carried most deliberately. It is what the
permit REQUIRES of the holder — a cash bond, a setback, a notice before
excavation — and a citizen who cannot read the conditions cannot comply with
them. Carried in full, not summarised and not counted.

**Two absences, told apart.** An application that is not yours answers the same
404 as one that does not exist; a permit number is the most disclosing field on
the record, and a distinguishable response would confirm that a neighbour has
applied. But an applicant reading their OWN application is told the permit is
simply not issued yet, rather than that their application is missing.

**Proved by break-check.** Removing the ownership pre-check makes Maria's token
return Jose's permit number, and the test fails. The break was asserted live
before the run — a patch that silently fails to match reads exactly like a
passing guard.

**Not folded into the application detail.** The detail is read on every list
refresh; the permit is read once, at the end. A join nobody needs on the common
path is a join every caller pays for.

### A second defect, found by recording the evidence

Regenerating the contract samples for this route emptied **every staff
collection sample** — the queue, the evaluations queue, the payments queue, the
business list. The access control added in migration 032 was working exactly as
designed: `scripts/emit-response-samples.ts` inserts staff accounts directly,
which skips 032's backfill, so those accounts hold no `staff_permit_access` rows
and every staff query filtered down to nothing.

This is the same class as the 57 test failures the migration caused, with one
difference that matters: **an empty list validates against almost any schema.**
The contract repository would have accepted the evidence and reported the
backend conformant, while the recorded bytes said the staff queue returns
nothing. The failure mode was silence, not a red gate.

Fixed in the emitter by granting each seeded staff account what the backfill
grants. Every collection sample now carries exactly the row count it carried
before the access-control work — 12 samples, 0 changes — so the restoration is
measured rather than asserted.

A caution for whoever reads this next: my first count of those rows reported
`0 rows` for every sample INCLUDING ones that plainly had rows, because the
counter read `response.body` and the samples key it as `body`. The scan was
failing against its own explanation. The real comparison is the 12-row table
above.

**The route table was also stale**, by nine routes: the seven access-control
endpoints, the MFA re-issue, and this one. It is generated by the emitter, so it
was stale only because nothing had regenerated it since TAB 13. Sample coverage
ratcheted 36 → 37.

Gate: 82 suites, 1639 tests, reachability 52/52 explained, recorded-response
check ok, secret scan ok over 302 files.


---

## C-2 CLOSED — `GET /applications/:applicationId/documents`

Shipped. A citizen can now see every document on their application and what the
office said about each: the verdict, the standard reason with its label, the
custom feedback written for them, the resubmission chain, and the document id.

**Every field already existed.** Migration 027 gave a document its own verdict,
a reason catalogue the LGU can edit, a free-text remark, and a supersession
chain — and no citizen-facing route read any of it. The application detail
mentions documents nowhere. So the office's careful reason ("Illegible", plus
"page 3 is cut off at the right margin — the setback dimension cannot be read")
reached nobody, and the applicant made another trip to ask what was wrong.

**The document id was undiscoverable.** `GET /documents/:documentId/content` and
the resubmit route both take one, and **no route returned one**. A citizen could
not re-download a file they had uploaded themselves. This route is the only one
that serves a document id.

### Three decisions

**The reason is returned as both code and label.** The code is what a client
switches on and what the LGU counts; the label is what the office wrote and what
a citizen reads. Sending only the code would make every client keep its own copy
of the catalogue — and that catalogue is deliberately editable by the LGU, so
those copies would drift.

**The malware scan is a separate axis from the officer's verdict**, and is kept
separate. Migration 027 already refused to widen `documents.status` for exactly
this reason: an officer marking a document Rejected must not make its bytes
unretrievable as though it carried malware. Two plain booleans — `scanCleared`,
`quarantined` — rather than a new vocabulary, because both clients throw on an
enum value they do not recognise.

**`reviewStatus: null` is a real state**, meaning "nobody has looked yet", not
"nothing is wrong". A client rendering null as a tick would tell an applicant
their document passed when it has not been opened.

`reviewed_by` is deliberately absent: naming the officer who turned a document
back is the officer-identity leak the applicant boundary exists to prevent.
Break-checked — leaking it fails the test, and removing the ownership pre-check
serves Jose's documents to Maria.

### What this does NOT do, and why it would have been a fabrication

**It does not say which required document is missing.** `documents` has no
`requirement_code` column: the checklist in `document_requirements` and the
uploads in `documents` are joined by nothing. Matching them would mean guessing
on the label — and `evaluation.service.ts:149` had already reached the same
conclusion and written it down.

A "Missing Documents" figure derived from a label match would be a number that
looks measured and is not. Migration 027's `review_status` does carry a
`'Missing'` value, so an officer can mark a specific document missing and that
now reaches the citizen; what cannot be computed is which checklist entry has
no upload at all.

**Filed as C-6:** give `documents` a nullable `requirement_code` referencing
`document_requirements`, set at upload. Until then no surface should claim to
know which requirement is unmet.

### Also still true

A document uploaded with `applicationId: null` — which `POST /documents` allows —
is reachable from nowhere. This route is per-application, so it cannot list one.
Either the upload should require an application, or `GET /me/documents` should
exist. Filed as **C-7**; it is not reachable through any client flow today.

Gate: 82 suites, 1642 tests, reachability 50/50, recorded responses ok (coverage
ratchet 37 → 38), secret scan ok over 304 files.


---

## D-8 CLOSED — `POST /applications/:applicationId/documents/:documentId/resubmit`

The mobile client had called this route since before it existed. It returned
404, and the client's own comment recorded that as a hand-off rather than
faking a success — the right call, and the reason this was a known gap rather
than a mystery.

**It appends, never overwrites.** The replacement is a new row pointing at what
it replaces, so the old document keeps its rejection and the reason given for
it. That is the pair that makes a rejection actionable — what was wrong, and
what was sent instead — and C-2 now shows the applicant both. Migration 027
modelled the chain; this is the route that finally writes it.

**The file goes through the existing upload path**, not a second one. Magic-byte
inspection, metadata scrubbing, the malware scan and the object-store write are
the risky parts, and a second implementation of them is a second place for them
to be wrong. `supersedes_document_id` is set in the INSERT rather than by a
follow-up update, so the unique index is the authority: two resubmissions racing
to replace one document cannot both win.

### What it refuses, and why

* **Already replaced → 409.** The unique index would refuse it anyway, but only
  after the bytes were stored and scanned. Refusing first means a citizen who
  taps twice does not pay for an upload that was never going to land.
* **Already accepted → 409.** Replacing a document an officer approved would
  silently undo that approval with nobody told. An officer can mark it Expired
  or Revision Required; that decision belongs in the office.
* **Not on this application → 404**, the same 404 as a document that does not
  exist. A document id that behaves differently on someone else's application is
  a way to learn that application exists.

### It does not move the application

Responding to a Letter of Instruction is what returns an application to Under
Evaluation, and it already does that with the item responses in one transaction.
A second route making the same transition would be two paths to one state,
disagreeing the first time either changed.

### The idempotency key is honoured, not just accepted

Without it, a dropped connection is the bad case: the server commits, the
response is lost, the client retries, and meets the already-replaced refusal —
being told its own success was a conflict, so the applicant believes the
document was never sent. The key is looked up **before** the preconditions for
exactly that reason, and the file is part of the fingerprint, so the same key
carrying a different replacement is refused rather than answered with the first
document's id.

This uses `src/persistence/idempotency.ts`, which exists because the payments
module grew one inline and the comment there says plainly that a second inline
copy is how two operations come to disagree about what a replay means.

**Where it is honest about a gap:** the key is recorded after the document
exists, not inside its transaction — the upload spans an object-store write and
a malware scan, and holding a database transaction across those would be worse
than the gap it closes. A crash between the two leaves a document with no key;
the retry then finds it already replaced and is refused rather than duplicating
it. Safe, and the refusal is the wrong message for that one case.

Break-checked three ways: dropping the supersession link, removing the
already-replaced precondition, and disabling the replay each fail a test.

Gate: 82 suites, sample coverage ratchet 38 → 39.


---

## C-8 — the real ceiling on an attachment is ~750KB, not 30MB

Raised by the mobile lane's note that a building permit can carry **24
attachments** and that its first real filing will be the first time `/documents`
sees that volume. The count is fine; the **size** is the problem.

**24 is safe.** `documentIds` caps at 60, and the rate limit is 300 requests per
60 seconds against 24 uploads plus one filing.

**The per-file ceiling is not what the schema says.** `contentBase64` is capped
at 40,000,000 characters by the request shape, which reads as "a 30MB file is
fine". It is not. The Fastify adapter's `bodyLimit` is `BODY_LIMIT_BYTES`, which
defaults to **1MB** and is 1MB in `.env.example`. Base64 inflates by about a
third, so the real ceiling on a FILE is roughly **750KB** — and a scanned
building plan routinely exceeds that.

**Where it is enforced makes it worse.** The adapter refuses the body before any
handler runs, so the applicant does not get the upload route's problem document
explaining what to do. They get a bare **413**. Measured, and now held by a test:
a ~400KB PDF is accepted 201; a ~900KB PDF is refused 413 with nothing stored.

Two things follow, neither of which this lane should decide alone:

1. **`BODY_LIMIT_BYTES` needs raising for production**, to whatever the LGU's
   real plan scans are. The value is deliberately configurable — the comment in
   `app-config.ts` says a value requiring a rebuild is a value nobody tunes — so
   this is a deployment decision, not a code change.
2. **The 40,000,000 cap on `contentBase64` should not outrun the body limit.** A
   schema promising thirty times what the adapter will accept is a promise the
   server cannot keep, and it is the kind of divergence a client reads as a
   server bug.

Filed rather than fixed: raising the limit without knowing the real file sizes
would be picking a number, and the client-visible half (a bare 413) is only
worth changing once the limit itself is settled.


---

## C-6 CLOSED — a document says which requirement it answers

`document_requirements` said what a permit type asks for, `documents` held what
was sent, and **nothing joined them**. So no surface could name a missing
document without matching on the label — a guess `evaluation.service.ts` had
already refused to make, and one the admin front end shipped once as a "Missing
Documents" column computed from a hash.

Migration 035 adds `documents.requirement_code`, and
`GET /applications/:applicationId/requirements` is what reads it.

### No foreign key, deliberately

The authority for a filed application is **not** the live catalogue. Migration
022 snapshots the checklist onto `applications.required_documents` at filing,
because the checklist changes and a filed application must not. A key into
`document_requirements (permit_type, code)` would point at what the catalogue
says *today* — the wrong list to judge an old application against — and would
break the moment the LGU retired a code some filed application still references.

A document is also uploaded **before** its application exists: `POST /documents`
takes a nullable `application_id`, and both clients upload first and file
second. So at write time there is usually no permit type to check against.

The code is therefore validated at **submission**, against the list being
snapshotted onto that application — the list it will actually be judged by. An
unknown code refuses the filing (422) naming it, rather than being quietly
nulled: a code naming nothing is a client bug, and dropping it would leave the
applicant believing they had answered a requirement they had not.

### Null means NOT ATTRIBUTED, and the read side says so

Every document uploaded before this migration carries a null code, as does any
from a client that sends none. Counting requirements with no matching code and
calling them missing would report **every** item missing on an application whose
documents all predate the column — worse than reporting nothing.

So `unattributedDocuments` travels with the list, and `attributionComplete` says
in one field whether `not-provided` can be trusted. A caller cannot render
"3 missing" without also holding "and 7 documents nobody attributed", which is
the difference between a measurement and an accusation. **The recorded contract
sample is deliberately the incomplete case**, because a sample showing only the
tidy state would let a client ship a missing-documents list it has no right to
present as certain.

### Two properties worth naming

**A replacement inherits the attribution.** Taken from the superseded document,
not from the client: an applicant resubmitting is responding to a verdict, not
choosing a requirement afresh. Without it a requirement would flip from provided
to not-provided the moment the applicant fixed it. Break-checked.

**`provided` is not `accepted`.** It means a document is attributed to the entry,
not that an officer approved it — that is `reviewStatus` on the document.
Conflating them would tell an applicant their rejected lot plan satisfies the
requirement it failed. Superseded documents are excluded from `documentIds`, so
a replaced-and-accepted requirement does not still read as rejected because of
what it replaced.

**C-7 remains open** and is now the last of the original list: a document
uploaded with `applicationId: null` is reachable from no route.

Gate: 83 suites, 1675 tests, coverage ratchet 39 → 40.


---

## C-7 CLOSED — an upload that was never filed

Worse than this document originally recorded, and the correction matters.

**It was not "reachable from nowhere".** `ownedBy` reads `uploaded_by` as well
as the application's applicant, so a citizen holding the id could always
retrieve the file. The accurate word is **undiscoverable**: nothing listed it.

What made it serious is that an abandoned upload was invisible to **all three**
mechanisms that would otherwise handle it:

1. **Retention could not reach it, by construction.** `runRetention` joins
   `applications` to find the closing transition that starts the clock, so a
   document with no application is dropped by the INNER JOIN. Not "not yet
   eligible" — unable ever to become eligible.
2. **Erasure does not delete it.** `ERASE_IN_ORDER` covers the
   `account-lifetime` tables; `documents` is classified `statutory` on the
   basis of being part of a permit record, which an orphan never was.
3. **Nothing listed it**, so the citizen could not see it to act on it.

Net effect: a PSA certificate, or a lot plan carrying a home address, uploaded
during a session somebody abandoned, held **indefinitely** — nobody's permit
record and nobody's to find.

### What shipped

**Retention now reaches them**, keyed on `uploaded_at` because there is no
closure event to read, deleting the object bytes and soft-deleting the row with
a chained audit entry exactly as the filed path does.

**The period is the LGU's, and the same one, deliberately.** `runRetention`'s
own comment says a retention period invented in this service "would be a
data-minimisation decision made by the wrong party", and that applies no less to
abandoned uploads. They are **counted and reported separately**, so an operator
can see the difference and ask for a shorter clock — which they probably should,
since an abandoned upload is part of no record at all. **Filed as an owner
question.**

**`GET /documents/me`** lists the caller's unattached uploads. Only unattached
ones: documents on an application are already served in context by
`GET /applications/:id/documents`, and a second answer to an answered question
drifts from the first the moment either changes. No review fields, because
nothing here has been reviewed — returning nulls would invite a client to render
"not yet reviewed", which suggests somebody will.

**The dangerous case is the one worth testing.** A citizen part-way through a
filing has documents uploaded minutes ago and no application yet — structurally
identical to an abandoned one. Deleting those would break the very flow the
nullable `application_id` exists to support. Both directions are break-checked:
excluding orphans again fails the first test, ignoring the clock fails the
second.

### Still open, and NOT fixed here

**Erasure deletes no document rows and no object bytes at all.** It is a
database-row deleter with no object-store access, and an object deletion cannot
participate in its transaction — if the transaction rolled back after the bytes
were gone, the row would survive pointing at nothing.

For an attached document that is coherent: the statutory basis keeps both. For
an orphan there is no such basis, so a citizen who asks to be forgotten keeps
their abandoned uploads until retention collects them, which is far longer than
an erasure request implies.

Fixing it properly needs a decision about how object deletion participates in
erasure — a purge pass over soft-deleted rows is the likely shape. Filed rather
than half-built, because a partly-implemented privacy mechanism is worse than a
documented gap.

Gate: 84 suites, 1693 tests, coverage ratchet 44 → 45.


---

## C-3 CLOSED — `PATCH /me`, the RA 10173 §16(d) right to rectification

A citizen can correct their name and mobile number. Not a settings screen: a
statutory right, which is why it is audited and why it refuses a field it
cannot apply rather than ignoring it.

**Email is deliberately NOT rectifiable.** It is the sign-in identity, so a
change is not a correction but a transfer of who can reach the account —
performing it without first proving control of the new address would turn a
rectification route into account takeover. The schema is `.strict()`, so a
client sending `email` is told (400) rather than watching the field be dropped
and believing the address changed. It needs the request/confirm shape the
contact channels already have. **Filed as an open piece of work.**

**Changing the number un-verifies it.** The verification belonged to the OLD
number — a code was sent there and answered from there — so carrying
`mobile_verified_at` across would assert that somebody proved control of a
number nobody ever messaged. Pending challenges for the channel are deleted
too: one outstanding against the old number would otherwise be confirmable
afterwards and would verify the NEW one. Both break-checked.

`mobileVerificationCleared` is returned explicitly, so a client re-prompts
rather than leaving a citizen with an unverified contact they believe is
verified.

**A staff member's name is not self-service.** It is set by the office on their
access request and stands against their acts in the audit trail; correcting it
belongs to an administrator.

**The audit entry carries no values.** Recording the old and new number would
re-create the personal data the citizen just corrected, in an append-only table
nobody can edit afterwards.

### Two defects found while building it

**A self-inflicted deadlock.** `AuditService.append(input, tx = this.db)`
defaults to the POOL, so calling it inside a transaction took a second
connection while the first was held — and PGlite serves one, so every request
that reached the database hung until the test timed out at 21 seconds. It
presented as a slow query. It was also wrong for correctness: an entry written
outside the transaction survives a rollback and claims a correction that never
happened, which is the rule `remember()` already states for idempotency keys.

**Tests written against a table that does not exist.** They asserted on
`audit_entries`; the table is `audit_events`, with `before_state`/`after_state`
rather than a `payload` column. Reading the schema turned a green-looking
assertion into a real one.

### Also established

**There was no way to change a mobile number or an email at all.** The contact
channels only verify what is already on record — `POST /me/contacts/:channel/
request` takes no new destination. C-3 closes that for the mobile number. Email
remains open, by design.

Gate: 84 suites, 1702 tests, coverage ratchet 45 → 46.


---

## The citizen's own address — asked for by BOTH front ends

Migration 036. `applicants` was `(id, account_id, first_name, last_name)`: there
was nowhere to store an address at all, so both clients accepted the change,
showed it back to the citizen, and sent nothing. Both changed what the screen
says rather than inventing a call, which is why this was a gap and not a live
lie.

**The purpose, which is what unblocked it.** I had told the mobile lane this
needed an owner decision, because RA 10173 requires a purpose and a lawful basis
per field and "the app has a box for it" is neither. The web portal supplied
one: *this is the address the office writes to about an application* — a notice,
a letter of instruction, a permit ready for collection — and a citizen who moves
currently has to telephone the Municipal Engineer. That is recorded in the
register as its own basis, `CORRESPONDENCE`, deliberately separate from
`PERMIT_RECORD` on the name beside it: the name says who holds the permit, the
address exists so the office can reach them about it.

**Three addresses, three purposes, none interchangeable:**
`applications.location` is the SITE, `businesses.street` is where a business
operates, and this is where to post a letter to the applicant.

### One vocabulary

`street`, `barangay`, `city`, `province` are what `businesses` already calls
these, verbatim. Both clients asked for `address`; that would be a second
spelling of one idea inside one service, which is the defect D-10 spent a
migration undoing. **Where the server already has a name, the server's name
wins; where it has none — `postalCode` — the clients' name stands.**

### null and absent mean different things

Absent leaves a field alone; **null clears it**. A citizen who typed a middle
name by mistake, or has none, must be able to remove it: a right to correct that
cannot remove is half a right. `??` cannot express this — it treats null as
absent — so the presence of the KEY decides and the value passes through
untouched. Break-checked.

Every existing applicant reads null, meaning NOT RECORDED. Nobody has ever been
asked for this, and a client must not render it as a blank the citizen chose.

### The mobile-number model, decided by measurement

Both lanes asked whether a number change should take effect immediately or wait
on verification. **Immediately, with verification reset** — and the reason is
not a preference: `POST /me/contacts/mobile/request` returns
`delivery: 'not-sent'`, because the LGU has **no message provider configured**.
Under a pending-verification model a number change could never complete, and
every citizen who moved would be stranded on their old number for ever.
Apply-then-re-verify is the only model the existing infrastructure supports.

### Registration is now strict

`POST /auth/register` was not `.strict()`, so Zod **silently stripped** unknown
keys: a client adding `address` there would have received **202** with the field
discarded. Verified against the live mobile client first — it sends exactly the
five accepted fields, so nothing breaks — and now a client's next addition fails
loudly instead of vanishing.

Gate: 84 suites, 1707 tests.
