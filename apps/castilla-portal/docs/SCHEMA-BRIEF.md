# TAB 00 — schema design brief

To be reviewed before any migration is written. This is the shape TAB 01 will
implement, and the reasoning behind the parts that are not obvious.

## The central decision: provenance and confirmation are not per-entity

Both attach to a **field**, not a record. That follows from the data rather than
from taste: one office already carries different provenance for its head than
for its telephone, and one office has a confirmed `hours` value inside an
otherwise unconfirmed contact. A record-level flag cannot express either, which
is exactly why the current front end string-matches the literal
`'Pending confirmation'` — the coarse flag forced a sentinel into the data.

    field_state(entity_type, entity_id, field_name)
      -> confirmation_state: 'confirmed' | 'pending' | 'withheld'

    provenance(entity_type, entity_id, field_name, ...)
      -> source_description, source_url NULL, sourced_on, method

`method` is an enum — `direct-read`, `search-extraction`, `official-document` —
because several facts were obtained by search extraction *because* the official
domain blocks automated fetching, and that is part of the record, not a
footnote.

### The constraint that has to be in the database

**Confirmed implies provenance.** Not checked in application code, where a
second write path can forget it. Expressed as a trigger or a deferred
constraint over `field_state` and `provenance`, so a confirmed value with no
source is rejected by PostgreSQL.

This is also what makes TAB 02's concurrency criterion satisfiable: two
concurrent confirmations of one field must produce one confirmed value and one
rejection, never two provenance rows racing. A unique key on
`(entity_type, entity_id, field_name)` in `field_state` plus the confirmation
happening in one transaction gives that for free.

### Three states, not two, and no second boolean

`withheld` is distinct from `pending`: pending is *nobody has confirmed this
yet*, withheld is *we have decided not to publish it*. The owner's ruling on
personal contacts needs the second, and TAB 01 forbids adding a
`verified_by_lgu` boolean beside the state — one state machine.

## Entities

`offices`, `office_categories`, `officials`, `permits`, `permit_office_groups`,
`profile_fields`, `forms`, `content_pages`.

**Slugs are the public identifier** and must be stable — they are already in
citizens' URLs. Surrogate keys internally; the slug is what the API speaks.

### Ordering is data

Permits, profile fields, services, requirements and the office listing are all
deliberately ordered — the office listing groups executive offices first, and
TAB 03 forbids sorting by name. Every one of those gets an explicit `ordinal`.
A set has no order, and "the order they came back in" is not a guarantee.

*(This is a lesson carried from the eBPCO backend, where reading a lifecycle out
of SQL silently reordered it alphabetically and turned a process into an index.)*

### Nullability that must survive

`permits.issuing_office_slug` is **nullable and stays nullable** — the two BFP
permits point at a national agency with no municipal office record. The foreign
key allows null; `issuing_office_name` carries the text. No migration, seeder or
tidying pass may invent a BFP office row.

### Contacts

Four independently confirmable fields — `telephone`, `email`, `location`,
`hours` — each with its own `field_state`, because one office already has a
confirmed `hours` inside an unconfirmed contact.

Each contact value also records **`is_institutional`** — whether the address or
number belongs to an office or to a named individual. The owner's ruling is that
personal ones are withheld; the schema carries the distinction so the ruling is
data rather than a filter someone remembers to apply.

Withdrawal sets the field to `withheld`. It never deletes the office and never
deletes the value.

### Services

An ordered list in its own table, not free text. TAB 08's search reads it, and
it is the reason four of the likeliest search terms on a building-permit portal
currently return nothing.

## What must not cascade

**No `ON DELETE CASCADE` from any entity to `provenance`.** Losing why a fact was
published is worse than an orphan row. Provenance and audit outlive the thing
they describe.

## Audit (TAB 12), designed in now rather than added later

Append-only, enforced by database permissions rather than discipline: the
application role gets `INSERT` and `SELECT` on the audit table and no `UPDATE`
or `DELETE`. TAB 12 is explicit that it is unimplementable retroactively.

Two hazards worth naming before they are written, both learned the hard way in
the eBPCO backend:

- **One transaction, both or neither.** The audit row and the change it records
  commit together. An audit written outside the transaction is lost by a
  rollback that keeps the change.
- **Do not let a row lock bound what can be audited.** A hash-chained audit that
  takes a global lock per append makes audit volume request-scale on any hot
  path, and that is a denial of service against the audit trail itself. If a
  chain is used here, any append on a request-scale path needs a bound.

## Seeding (TAB 15) — the constraint that shapes the schema

The seeder must be **idempotent**: re-running against a populated database
changes nothing and creates no duplicate provenance rows. That means natural
keys — `(entity_type, entity_id, field_name)` for state and provenance, slugs
for entities — and upserts keyed on them, not blind inserts.

**Never auto-confirm on import.** A seeded value is pending unless the committed
comment cites a source. Two traps found while reading, recorded in the scope
note: a stale header comment that contradicts its own field, and two officials
deliberately recorded under ballot names.

## Open before migrations are written

1. Which repository this lives in.
2. Whether `b5324d6` supersedes `dbacca5` as the gated commit.
3. Whether `field_state` and `provenance` key on `(entity_type, entity_id)` as a
   polymorphic pair, or one table per entity type. The polymorphic pair is what
   TAB 01 mandates and it cannot carry a foreign key — which is a real cost, and
   the reason the "no cascade" rule above has to be enforced by convention plus
   a reconciliation check rather than by the schema alone.
