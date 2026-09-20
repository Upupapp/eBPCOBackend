-- The Citizens module (staff/citizens/*) — administering a citizen's own
-- account, as distinct from the Businesses/Applications screens that already
-- show a citizen indirectly.
--
-- `disabled_reason`: `accounts.disabled_at` (migration 002-era) has always
-- recorded WHEN an account was disabled and never WHY. Self-service disable
-- has no reason — an applicant closing their own account needs none — but a
-- staff-initiated disable is an act taken about a specific person, on a
-- specific occasion, for a stated cause (a records dispute, suspected fraud,
-- an LGU request), and that belongs on the record next to the timestamp it
-- already has rather than living only in the audit chain's `after_state`,
-- which no screen renders back to the officer who reads the account later.
--
-- Nullable, because most disables still have no reason (self-service) and
-- `not null` would force one where none exists.
alter table accounts
  add column disabled_reason text;

-- Content, not a bare status flag: an officer writes free text here about why
-- THIS citizen's account was disabled, which may readily name the citizen, a
-- document, or an incident involving them — the same reasoning
-- personal-data.ts already gives `documents.review_remark` for an officer's
-- free text about a specific applicant, not the narrower one it gives
-- `payments.rejection_reason` (a note about a transaction, not a person).
comment on column accounts.disabled_reason is
  'pii:content:staff-note — lawful basis: accountability under NPC Circular 16-01 — who did what to whose record';

-- The list screen's search: name and email, case-insensitively, without
-- scanning the whole table. `applicants(lower(last_name), lower(first_name))`
-- rather than two separate indexes, because the list's own ORDER BY and its
-- most common search shape (a surname, then a given name) both read as one
-- name, left to right — the same reasoning `staff-businesses.controller.ts`
-- already orders `businesses` by `b.name`.
create index applicants_name_lower_idx
  on applicants (lower(last_name), lower(first_name));

-- Email search reads `accounts.email_normalised`, which migration 001 already
-- indexes for uniqueness (`accounts_email_normalised_key`) — no new index
-- needed there. Mobile search reads `accounts.mobile_number`, low-cardinality
-- enough on a municipal citizen register that a sequential scan alongside the
-- two indexes above is the right cost, not a third index for a column that is
-- nullable and rarely the only filter in play.
