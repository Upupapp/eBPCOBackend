# L-2 — a permit has no standing, and four questions before the first one issues

Raised by the citizen web portal lane. **Confirmed against the schema, not
assumed:** `generated_permits` is `application_id`, `permit_number`,
`issued_date`, `scope`, `conditions`, `generated_by`. There is no status, no
revocation and no expiry anywhere in the migrations.

So today a permit, once generated, is **valid for ever and unconditionally** as
far as this service can say. The portal has built `PermitStanding` to fail
closed, which is why every permit currently reports **Unverified** — the correct
behaviour, and not a state anyone wants to ship into a live office.

This is an **owner decision**, not a backend one. Every option below is
technically cheap; what they differ in is what the LGU is willing to say in
public about a permit it has withdrawn. Recording the questions rather than
picking answers.

---

## 1. What are the withdrawn states?

They are not one thing, and collapsing them would lose the distinction that
matters to a citizen standing at a counter.

* **Revoked** — the office withdrew it. The holder did something, or the permit
  should not have issued.
* **Suspended** — withdrawn *for now*, pending something. Recoverable.
* **Expired** — nobody withdrew anything; the clock ran out. Needs an
  `expiry_date`, and therefore a rule about what sets it. A building permit's
  validity is set by PD 1096 and is not the same for every permit type.
* **Superseded** — a later permit replaced it, e.g. an amended scope.

**The question:** which of these does Castilla actually use, and is expiry a
date this office sets per permit, derives per permit type, or does not track at
all today?

## 2. Who may withdraw one?

Issuing is already audited through `generated_by`, and **withdrawing a live
permit is at least as consequential as issuing one** — arguably more, because
the holder has already relied on it.

The existing role table gives `staff:approve` to the building official, which is
who issues. The plain reading is that withdrawal belongs there too, but that is
a ruling to make rather than infer, and there is a real argument for four-eyes:
the officer who issued it should perhaps not be the one who quietly withdraws it
alone.

**The question:** building official alone, or building official plus a second
approver? And may a super admin do it?

**Whatever the answer, the reason is mandatory.** This service already refuses
an adverse verdict with no reason in three places — evaluations, letter-of-
instruction items, document reviews. A revocation with no stated reason would be
the first, and it is the one where a citizen is most entitled to an explanation.

## 3. How does a client learn?

The portal is right that this is the crux: **a cached "Valid" for a permit
revoked this morning is the same defect moved, not fixed.**

Options, in ascending order of how much they cost:

* **Read on demand.** Standing comes back on the permit endpoint and is never
  cached by the client. Simplest; correct; costs a request whenever it is shown.
* **A short cache with an explicit `checkedAt`.** The client may cache but must
  display when it last checked. Honest, and it makes staleness visible rather
  than invisible.
* **A notification on withdrawal.** The holder is told. Requires a catalogue
  entry both citizen clients can parse — and the mobile client's enum parser
  throws on an unknown type, so this is a coordinated release, not a backend
  change.

**The question:** is being told a *requirement* — does the LGU owe the holder
notice of revocation? — or is read-on-demand sufficient?

## 4. Is a withdrawn permit's existence public?

The sharpest question, and the reason this is not a backend decision.

Three positions, each defensible:

* **Public.** A neighbour or a supplier can verify that a permit number is no
  longer valid. This is the point of a permit number being on a signboard.
* **Holder-only.** The permit's own applicant sees the standing; nobody else can
  look one up.
* **Existence public, reason private.** The number resolves to
  "not valid — contact the Office of the Building Official", and the reason is
  disclosed only to the holder.

Note what the third protects: a revocation reason is personal data about the
holder, and RA 10173 applies to publishing it. A public verification endpoint
also creates something this service does not currently have — **a route that
answers questions about a permit to someone who is not the applicant** — which
is a disclosure surface to design deliberately rather than acquire by accident.

**The question:** which of the three, and if verification is public, is it by
permit number alone or does it require something the holder would have to share?

---

## What this lane will do once answered

A migration adding standing to `generated_permits` with the states chosen, a
mandatory reason on any adverse state, attribution matching `generated_by`, and
the standing surfaced on `GET /applications/:id/permit` for the holder. Whether
anything is served to a non-holder depends entirely on question 4.

**Nothing here should be built before the answers.** A guessed state machine
would need a data migration to correct, and a guessed disclosure rule would be a
privacy decision made by a developer.

## Until then

`PermitStanding` failing closed to **Unverified** is the right behaviour and
should stay. It is honest: this service genuinely cannot say whether a permit is
still valid, and a client asserting "Valid" from the mere existence of a row
would be stating something nobody checked.
