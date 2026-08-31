# D-10 landed — the office's nineteen names are the keys

Ruled by the owner on 31 August 2026 and applied here by migration
`033_permit_vocabulary.sql`. The handoff from the mobile lane
(`HOWTO-D10-land-the-permit-seed.md` in eBPCOMobile) was accurate on every
point it made; this records what it did not cover, and the two defects the
work surfaced.

**Measured against a running instance, over a real socket: `19 of 19`.**
Before this, `1 of 19` — only `Certificate of Occupancy` was spelled the same
in both vocabularies.

## What the handoff got right, confirmed independently

* **Five foreign keys, not four.** Confirmed by querying `pg_constraint`
  against a migrated database rather than reading the migrations:
  `applications`, `charter_entries`, `document_requirements`,
  `fee_schedule_entries`, `staff_permit_access`. All five were
  `ON UPDATE NO ACTION`, so a bare rename fails on every one; two carry
  `ON DELETE RESTRICT` and the migration preserves exactly those two.
* **The nineteen names.** Not retyped. They are byte-identical to
  `contract/permit-vocabulary.json`, this repo's fixture pinned from the admin
  portal at commit `8cabc0c` — a second extraction of the same source, agreeing
  with the mobile lane's to the character, en dashes included.
* **The en dash.** Three names carry U+2013. Asserted on the database rather
  than on the fixture, because the fixture is where it was already right and
  the migration is where it could have been typed wrong.
* **`Sanitary/Plumbing` → `Sanitary Permit`.** Independently supported: this
  repo's own deleted mapping file had already concluded, from the bundled forms
  NBC A-05 (Sanitary, Code on Sanitation) and NBC A-06 (Plumbing, Revised
  Plumbing Code), that the combined key was stale and meant Sanitary. Two forms
  under PD 1096, certified by different licensed professionals.

## Two defects the handoff's plan would have shipped

### 1. Every permit number would silently have become `PRM-`

`PERMIT_NUMBER_PREFIXES` maps permit type to the prefix printed on the issued
permit — `BP-2026-000001`, `FP-`, `SPP-`. It was keyed on the **old** names, and
an unrecognised type falls back to `PRM` **deliberately, without failing**, so
that a permit type the LGU adds cannot stop a permit being issued.

The rename changed all seventeen keys at once. Nothing would have thrown. Every
permit number issued afterwards would have read `PRM-2026-######`, on the
document a citizen reads aloud at a counter, for ever.

It was caught only because a standing test reads the seeded types **from the
database** and asserts each has a prefix — a guard written after the first
version of that table invented names the reference table did not have. The
prefixes moved with the keys; the three new types got `ZLC`, `FSEC` and `FSIC`,
the abbreviations already on the paper.

### 2. A citizen could file into a black hole

**Inserting a permit type is not the same as opening it.** The staff queue
filters on `staff_permit_access`, and the lifecycle write check refuses any
transition without a row there. Migration 032 granted every staff account every
permit type; the three types D-10 adds would have been granted to **nobody**.

So the scope half of the ruling — eBPCO accepts the zoning clearance and the two
BFP clearances — would have accepted the filing and then shown it in no
officer's queue, transitionable by no one. Accepted, unread, unactionable.

Migration 033 now grants the three new types, but **only to accounts that
already hold every pre-existing type**. An officer deliberately narrowed to a
subset stays narrowed — widening them is an authorisation decision for a super
admin, not for a migration — while an account holding everything holds
everything by construction, which is the same "preserve today" rule 032 used.

The guard is the existing backfill test, which read `17 granted` against
`20 types`. Break-checked: removing the grant makes it fail again.

## The cast is gone, and cannot come back

`src/modules/permits/domain/published-vocabulary.ts` held the mapping between
the two vocabularies. Under the ruling it is exactly the forbidden thing — a
third spelling with no authority, invisible to every client — so it is deleted.

That mattered more than a tidy-up: `publishedNameFor` was **live in production**,
feeding `permitTypeName` on both the citizen and staff queries. Left in place
after the rename it would have returned `null` on every row, because its keys
were the old names. The recorded samples now show `permitTypeName` populated and
equal to `permitType`; the field is kept, and redundant, because both clients
read it today and the ruling was that the backend moves and the front ends do
not. It is the one thing here worth retiring once no client reads it.

**Deleting a cast is not the same as preventing one.** A new gate,
`permit-vocabulary.spec.ts`, asserts the seeded table against the same pinned
fixture the deleted mapping was checked against. If either side moves, it fails.

## A second trap in the same class: the comments

A mechanical find-and-replace rewrote the *explanations* as well as the code,
and every one of them was a contrast between the two vocabularies. Three
comments were left asserting a string against itself:

* `applicant-view.ts` and `staff-queue.service.ts`, on `permitTypeName`:
  *"this service's internal key -- 'Fencing Permit' ... the portals publish a
  different, longer vocabulary -- 'Fencing Permit'."*
* `staff-access.spec.ts`: *"a near-match must NOT be treated as a match:
  'Fencing Permit' and 'Fencing Permit' are different vocabularies."*

None of these fails a gate — a comment cannot. They were found by scanning for
comment lines naming the same permit twice, which now returns zero. Both
`permitTypeName` declarations also still typed the field `string | null`, a null
that migration 033 made unreachable; narrowed to `string`, and the typecheck
confirmed no consumer depended on it.

The `staff-access` test was re-founded rather than reworded, on the two ways
this exact string will actually arrive wrong: the retired key, and the en dash
typed as a hyphen.

## A trap in the fixtures worth naming

Three tests used `'Fencing Permit'` **because it was not a real key** — the rule
being that a published display name must never decide authorisation. The rename
made that string real and turned three negative tests positive; a mechanical
find-and-replace also rewrote one of their comments into the nonsense
*"a published name — 'Fencing Permit' rather than 'Fencing Permit' — must not be
storable"*.

The premise died with the ruling: there is no published name distinct from the
key any more. So they are re-founded rather than repaired, on the **retired**
key `'Fencing'` — which is the live risk after a rename (a stale client, a
cached config, an un-migrated service) and must not be storable, because a row
in `staff_permit_access` is an authorisation grant.

## The slash, measured rather than reasoned about

**Four** of the nineteen names contain a forward slash — `Civil / Structural
Permit`, `Zoning / Locational Clearance`, and the Renovation and Addition
building permits — and three routes carry the permit type in the **path**,
including the citizen-facing `GET /requirements/:permitType`.

A slash is the one character that changes what a URL *means* rather than how it
reads. `%2F` routes correctly: verified in-process and then again over a real
HTTP socket against the running instance, `200` for both slashed names. A test
now holds it, because it is the kind of thing a router or a proxy changes
underneath you.

## One correction to the handoff

The proposed contract enum is **twenty values, not nineteen**. `Business Permit`
is not one of the office's nineteen and is deliberately retained server-side —
the clients' legacy flow still files against it, and a filing was accepted
against the running instance to confirm. Dropping it from `PermitType` would
make a validating client refuse a filing the server honours.

`openapi/ebpco.openapi.yaml` in `/Users/user/ebpco-contract` has been edited to
the twenty values and **left uncommitted**: that repository belongs to another
lane, and committing into someone else's checkout is not this lane's to do.

## Still open, unchanged

* **D-8** — `POST /applications/:id/documents/:documentId/resubmit` returns 404.
* **`serviceDomain`** — the contract still marks it required on the request
  while the server rejects it as unrecognised and derives it for the response.

## Naming

This is the *mobile* lane's D-10. In this repository D-10 already refers to the
administrator MFA re-issue shipped at `b81bfba`. Same label, two defects, two
lanes — noted so a later reader is not misled.
