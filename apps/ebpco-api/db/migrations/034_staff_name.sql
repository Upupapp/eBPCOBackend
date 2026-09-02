-- The officer's own name, which the office had already typed in.
--
-- F-32, raised by the admin portal lane: every officer sees their email address
-- in the topbar, because `GET /me` returns no name for a staff account. The
-- cause is not that nobody asked for it.
--
-- `access_requests.full_name` (migration 032) collects it at sign-up, and the
-- pending queue shows it to the super admin who approves the request. Then
-- `approve()` creates the account and the name is DROPPED, because `accounts`
-- has nowhere to put it. The office types the officer's name, an approver reads
-- it, and it is thrown away in the same transaction that creates the account.
--
-- ── One field, not two ────────────────────────────────────────────────────
--
-- `applicants` splits first_name and last_name. This does not, because what is
-- COLLECTED is a single full name, and splitting it here would be a guess:
-- Philippine names routinely carry two given names and a maternal surname, so
-- "first token, last token" produces a wrong name for exactly the people whose
-- names are least like the developer's. The admin lane asked for
-- firstName/lastName; it gets `fullName`, and changing what the sign-up form
-- collects is the only honest way to get the split.

alter table accounts add column full_name text
  check (full_name is null or length(trim(full_name)) > 0);

comment on column accounts.full_name is
  'pii:identity:name — the staff member''s own name, as the office entered it on their access request';

-- ── Recovering the names already collected ────────────────────────────────
--
-- Every officer approved through the access-request flow has their name sitting
-- in `access_requests`. Matched on the normalised email, which is what the
-- approval used to create the account, so this is the same identity and not a
-- fuzzy match.
--
-- Only 'approved' requests: a pending or rejected one names someone who has no
-- account, and a rejected one names someone the office declined.
update accounts a
   set full_name = r.full_name
  from access_requests r
 where r.email_normalised = a.email_normalised
   and r.status = 'approved'
   and a.kind = 'staff'
   and a.full_name is null;

-- Nullable on purpose, and stays nullable. A staff account created before this
-- flow existed -- the seeded super admin among them -- has no name on record,
-- and inventing one would be worse than a client showing the email it shows
-- today. The clients are told null means "not recorded", not "blank".
