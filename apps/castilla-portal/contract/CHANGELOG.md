# Contract changelog

The version in `openapi.json` follows this file. **Additive** and **breaking**
are separated deliberately: TAB 14 requires the two be distinguishable without
diffing, because a client generated from a stale contract is trusted precisely
because it looks current.

The rule for which is which:

- **Additive** — a new endpoint, a new OPTIONAL response field, a new optional
  request field, a widened enum on a response, better prose. A client written
  against the previous version keeps working.
- **Breaking** — a removed or renamed field, a field that becomes required, an
  optional field that becomes mandatory in a request, a narrowed enum, a changed
  status code, a changed path. A client written against the previous version
  stops working, or works and is wrong.

A field moving from optional to always-present is **breaking** even though it
sounds additive: clients branch on its absence.

---

## 0.2.0 — 2026-08-31

**Additive.**

- Documented the eight staff route/method pairs that existed in the
  implementation but not in the contract: the confirmation workflow (backlog,
  propose, confirm, revert), the announcement lifecycle (draft, publish,
  withdraw) and page replacement. No behaviour changed; the contract had been
  behind since TAB 11.
- Added `/search`, `/announcements`, `/pages`, `/forms` and `/session` (TABs
  08–11), each with its request and response schemas.
- Added `bearer` security scheme. Staff routes answer **404, not 401**, to an
  unauthenticated caller, so probing reveals nothing.
- Added `contract/examples.json`: a real response from every public endpoint,
  captured against the seeded data.

## 0.1.0 — 2026-08-30

Initial contract: `/offices`, `/offices/{slug}`, `/officials`,
`/municipality/profile`, `/permits`, `/permits/{slug}`.
