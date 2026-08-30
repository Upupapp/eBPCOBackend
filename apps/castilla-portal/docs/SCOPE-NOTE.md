# TAB 00 — scope note

Written 30 August 2026, before any schema was designed.

## This is greenfield

The portal makes **zero HTTP calls**. There is no `HttpClient`, no `fetch`, and
`@angular/common/http` is not provided. Nothing here migrates an existing API,
because there is no existing API, and the front end will not reveal what it
needs by the calls it makes — it makes none.

The consequence worth stating: the client will be written **from the contract**
rather than the contract adapted to the client. That is an advantage, and TAB 14
is where it is either protected or lost.

## Source of truth

Four committed TypeScript files, read in full including comments:

- `castilla-lgu-portal/src/app/core/data/municipality.data.ts`
- `castilla-lgu-portal/src/app/core/data/offices.data.ts`
- `castilla-lgu-portal/src/app/core/data/officials.data.ts`
- `castilla-lgu-portal/src/app/core/data/permits.data.ts`

with their models in `core/models/` — `office.model.ts`, `official.model.ts`,
`permit.model.ts`.

## The commit they were read at, and why it is not the one the command names

**Read at `b5324d6`.** The Master Command gates at
`dbacca51c9db18ef92986b1748590eb990fb70e3`, and that was `origin/main` when the
document was issued. It is not any more.

While these files were being read, the front-end lane committed and pushed
**`b5324d6` — "Fix four defects behind the green suite, and guard each one"** —
the fixes the command describes as existing but not deployed. `origin/main` is
now `b5324d6`.

Building against `dbacca5` would mean building against a specification the
repository has deliberately moved past, and **TAB 04 would be unimplementable**:
it mandates profile fields carrying "a numeric count, a suffix, and a decimal
precision", and at `dbacca5` `ProfileField` has only `label`, `value` and
`isPlaceholder` — Population is the single string `'60,635 (2020 Census)'`.
`b5324d6` is the commit that adds `count`, `countSuffix` and `countDecimals`.

**This needs the owner's agreement before TAB 01**, because the command's own
gate says otherwise.

## Measured baseline, recounted

TAB 15 requires any difference from the command's baseline to be explained
before seeding. Counted directly from the files at `b5324d6`:

| | Command | Measured | |
|---|---|---|---|
| Municipal offices | 19 | 19 | ok |
| Office categories | 6 | 6 | ok |
| Permits | 19 | 19 | ok |
| Permit office groups | 3 | 3 | ok |
| Profile fields | 11 | 11 | ok |
| Elected officials | 12 | 12 | ok |
| Permits with null issuing office | 2 | 2 | ok |
| Permit entries referencing a form | 14 | 14 | ok |
| Permits with no form | 5 | 5 | ok |
| Permits unconfirmed | 19 | 19 | ok |
| Office contacts | 10 published / 9 pending | 10 / 9 | ok |
| Office heads | 15/4 (baseline) vs 17/2 (TABs 02, 15) | **17 confirmed / 2 pending** | see below |

### The head count: the command disagrees with itself, and this is why

`head: placeholderHead(` appears **4 times at `dbacca5`** and **2 times at
`b5324d6`**, where a new `headFromOfficial()` derives the Mayor's and Vice
Mayor's office heads from `officials.data.ts`.

So the baseline page was measured at `dbacca5` (15 confirmed / 4 pending) and
TAB 02 and TAB 15 were measured with that fix applied (17 / 2). Both are
correct about different trees. **`b5324d6` matches TABs 02 and 15.**

### The contact count needed care

Eight offices use a `placeholderContact()` helper and eleven declare a contact
inline, which reads naively as 11 published. One of those inline contacts is
itself unconfirmed. The answer is **10 published / 9 pending**, matching the
command — but counting helper calls alone gives 11, a wrong figure that looks
plausible.

The nine offices with no published contact: Office of the Mayor, Office of the
Vice Mayor, Sangguniang Bayan, Municipal Administrator, Municipal Treasurer,
Municipal Health, Municipal Agriculture, Business Permits & Licensing, General
Services.

### One figure that does not reconcile at all

**TAB 17 requires "the front end's own 44-test suite" to pass.** Counted:

- `dbacca5` — 3 spec files, **10 tests** (matches the baseline page)
- `b5324d6` — 7 spec files, **28 tests**

44 is neither. TAB 17 is an acceptance gate, so the figure needs correcting or
explaining before it can be one.

## Three findings the data files carry in comments

These are the reason TAB 15 says the seeder must *read* the comments rather than
assume. Each would be destroyed by an ordinary importer.

1. **A stale comment contradicts its own data.** `municipality.data.ts`'s header
   says "Demonym and an exact PSA year-over-year population trend ... were not
   found from any citable source, so they stay pending". The Demonym field
   carries `isPlaceholder: false` with its own dated sourcing comment citing the
   Public Information Office's January 2026 post. The field is right and the
   header is out of date. A seeder trusting the header marks a confirmed fact
   pending.

2. **Two officials are recorded under ballot names on purpose.** Sangguniang
   Bayan members "Kap Luna Luna" and "Kap Budoy Mirandilla" appear that way in
   every source found, with a comment stating their full legal given names were
   not found and are not invented. Tidying these into plausible full names would
   fabricate a fact about a real elected official.

3. **The BFP permits' null issuing office is a fact, not a gap.** Two permits
   carry `issuingOfficeSlug: null` because the Bureau of Fire Protection is a
   national agency with no municipal office record. The model's own comment says
   `issuingOfficeName` is shown "in its place instead of a broken cross-link".

## Owner decisions taken, 30 August 2026

1. **`castilla-ebpco.online` is the LGU's official channel.** So the Municipality
   of Castilla is the data controller; TAB 09's privacy policy must be the LGU's
   own document rather than the placeholder now shipping; announcements are
   official notices.
2. **Personal staff contacts are withheld; institutional contacts only.** Held in
   the database, not served, with the office record intact and readable.
3. **Hosting:** the Castilla portal backend runs on the existing shared 2 GB
   Linode in Singapore. (eBPCO moves to its own 4 GB instance for unrelated
   reasons — ClamAV's signature reload.)

Decision 1 sharpens something the command notes: the site claims it collects no
personal data while embedding Google Fonts and an OpenStreetMap frame, both of
which disclose a visitor's IP to a third party. On the LGU's official channel
that is a false statement in a published privacy policy, and TAB 09's model must
be able to say what actually happens.

## Still open

- **Where this backend lives** — its own repository (assumed here, per the
  standing rule that backend and front end are separate repositories) or a
  sibling directory in `Upupapp/eBPCO-Website`, which TAB 00's wording
  ("the repository's backend README") suggests.
- **Whether `b5324d6` supersedes `dbacca5`** as the gated commit.
- **TAB 17's 44-test figure.**
- **TAB 10** — whether citizen intake is wanted at all. TAB 10 has an explicit
  exit and not building it is a valid outcome; a written decision is the
  deliverable either way.
