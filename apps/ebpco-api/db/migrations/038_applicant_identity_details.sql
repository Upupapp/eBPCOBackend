-- The rest of what the citizen web portal's registration form collects.
--
-- Same story as 036: the registration screen has asked for a date of birth,
-- sex, civil status and nationality since before this backend existed, and
-- `applicants` had nowhere to put any of them. `AuthService`'s own doc
-- comment on the web portal named this gap explicitly rather than inventing
-- a call, which is why this is a scheduled fix rather than a live lie.
--
-- Date of birth is not cosmetic: the portal age-gates registration at 18,
-- client-side only, because there was no field to check it against
-- server-side either.
--
-- ── Nullable, all of them ────────────────────────────────────────────────
--
-- Same reasoning as 036. No existing applicant has any of these four values,
-- there is nothing to backfill from, and a NOT NULL column would need a
-- fabricated one. Null means NOT RECORDED.
--
-- ── Enumerated, where the value is a closed set ──────────────────────────
--
-- `sex` and `civil_status` are checked against the exact option lists the web
-- portal's registration form offers (register.page.ts) — the same discipline
-- `businesses.category` and `applications.application_action` already use
-- elsewhere in this schema for a closed vocabulary. `nationality` is free
-- text, the same as `businesses.name`: nationality is not a closed list this
-- service is in a position to enumerate.

alter table applicants
  add column date_of_birth text
    check (date_of_birth is null or date_of_birth ~ '^\d{4}-\d{2}-\d{2}$'),
  add column sex text
    check (sex is null or sex in ('Male', 'Female', 'Prefer not to say')),
  add column civil_status text
    check (civil_status is null or civil_status in
      ('Single', 'Married', 'Widowed', 'Separated', 'Divorced')),
  add column nationality text
    check (nationality is null or length(trim(nationality)) > 0);

comment on column applicants.date_of_birth is
  'pii:identity:birthdate — lawful basis: performance of a public task (PD 1096 permit issuance); client-side 18+ age gate at registration depends on this being present going forward';
comment on column applicants.sex is
  'pii:identity:sex — lawful basis: performance of a public task (PD 1096 permit issuance)';
comment on column applicants.civil_status is
  'pii:identity:civil-status — lawful basis: performance of a public task (PD 1096 permit issuance)';
comment on column applicants.nationality is
  'pii:identity:nationality — lawful basis: performance of a public task (PD 1096 permit issuance)';

-- `date_of_birth` is TEXT, not DATE, deliberately: the rest of this profile
-- (street, barangay...) is text, `applications`' own date columns are the
-- exception rather than the rule for citizen-supplied fields, and the web
-- portal already sends `dateOfBirth` as a plain 'YYYY-MM-DD' string (its
-- native <input type="date"> value) with no timezone to lose in translation.
-- A DATE column would ask a client to parse and reformat a string it already
-- has in the right shape, for no value this table has a use for yet (nothing
-- here does date arithmetic on it — the 18+ gate is the client's own).
