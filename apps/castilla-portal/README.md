# Castilla LGU Portal — backend

The API behind the Municipality of Castilla public information portal at
`https://castilla-ebpco.online`.

The portal is a static Angular application with a well-sourced dataset compiled
into it. This service exists to put that dataset behind an API **without losing
the properties that make it trustworthy**. It is not a replacement for anything:
there is no existing API, and the front end makes zero HTTP calls today.

## The two invariants

Everything else in the eighteen commands is a design preference. These two are
not, and they are restated here in my own words because TAB 00 asks for exactly
that — a developer who cannot state them has not finished reading.

### Provenance is data, not a comment

Every user-visible fact on this portal has to be able to answer *where did this
come from*. Not in a code comment that an importer drops, and not in someone's
memory of the afternoon they looked it up — in columns, queryable, beside the
value.

A provenance record carries four things: **what the source was**, **its URL
where one exists**, **the date it was sourced**, and **how it was obtained** —
read directly, extracted from search results, or taken from an official
document. That last one is not bureaucratic detail. Several facts here were
obtained by search extraction *because* `castillasorsogon.gov.ph` blocks
automated fetching, and a reader deciding how much to trust the municipality's
founding date needs to know that.

A schema that stores the Mayor's name and drops "sourced 2026-08-23 from the
2025 local election results, cross-checked against two independent sources" has
kept the value and destroyed the reason anyone should believe it.

### `isPlaceholder` is a publication gate, not a nullable flag

It does not mean *missing*. It means **the LGU has not confirmed this**, and the
value is withheld from citizens while being kept in full.

The distinction matters because the draft value is where the confirmation
conversation with the LGU starts. Deleting it to make the column clean throws
away the work of finding it. Publishing it because it looks complete states
something about a real municipality that nobody has stood behind.

So: unconfirmed content must be **withholdable without being deleted**, and the
public API omits it rather than emitting a sentinel string. Empty columns here
are not bugs.

## Scope

- **In:** this API, its schema, its seeder, its contract.
- **Out:** `castilla-lgu-portal/` in `Upupapp/eBPCO-Website`. Reading it is
  required; writing it belongs to the front-end lane.
- **Out:** the eBPCO Web Admin's schema. It is a permit-transaction system for
  staff. The two share a permit vocabulary and nothing else.

See `docs/SCOPE-NOTE.md` for what was read, at which commit, and what was
measured; `docs/SCHEMA-BRIEF.md` for the design this produced.
