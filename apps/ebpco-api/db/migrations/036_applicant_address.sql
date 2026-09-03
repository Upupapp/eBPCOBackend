-- Where a citizen actually lives, so the office can reach them.
--
-- Asked for independently by BOTH citizen front ends. The mobile app found it
-- first (their 5fc45bd); the web portal hit the same wall. Until now
-- `applicants` was (id, account_id, first_name, last_name) and there was
-- nowhere to put an address at all -- so both clients accepted the change,
-- showed it back to the citizen, and sent nothing. Both have since changed
-- what the screen says rather than inventing a call, which was the right
-- thing to do and is why this is a gap rather than a live lie.
--
-- ── The purpose, because RA 10173 requires one per field ─────────────────
--
-- CORRESPONDENCE ABOUT AN APPLICATION. This is the address the Office of the
-- Building Official writes to about a permit: notices, letters of instruction,
-- a permit ready for collection. It is not collected because a form has a box
-- for it -- the web portal's report is that a citizen who moves currently has
-- to telephone the Municipal Engineer, which does not scale past a handful of
-- people.
--
-- Distinct from two addresses that already exist and do not serve this:
-- `applications.location` is the SITE the work happens on, and
-- `businesses.street` is where a business operates. Neither is where to post a
-- letter to the applicant.
--
-- ── One vocabulary, not two ──────────────────────────────────────────────
--
-- `street`, `barangay`, `city`, `province` are what `businesses` already
-- calls these, verbatim. Both clients asked for `address`; that would be a
-- second spelling of one idea inside one service, which is precisely the
-- defect D-10 spent a migration undoing. Where the server already has a name,
-- the server's name wins.
--
-- `postal_code` is the exception: `businesses` has none, so there is no
-- existing name to match and the clients' own request stands.
--
-- ── Nullable, all of them ────────────────────────────────────────────────
--
-- Every existing applicant has no address, and there is nothing to backfill
-- from: the data was never collected. A NOT NULL column would need a made-up
-- default, which is a fabricated address on a real person's record. Null here
-- means NOT RECORDED, and a client must not render it as blank-and-confirmed.

alter table applicants
  add column middle_name text check (middle_name is null or length(trim(middle_name)) > 0),
  add column street      text check (street      is null or length(trim(street))      > 0),
  add column barangay    text check (barangay    is null or length(trim(barangay))    > 0),
  add column city        text check (city        is null or length(trim(city))        > 0),
  add column province    text check (province    is null or length(trim(province))    > 0),
  add column postal_code text check (postal_code is null or postal_code ~ '^[0-9]{4}$');

comment on column applicants.middle_name is
  'pii:identity:name — lawful basis: performance of a public task (PD 1096 permit issuance)';
comment on column applicants.street is
  'pii:identity:address — where the office writes to the applicant about an application';
comment on column applicants.barangay is
  'pii:identity:address — where the office writes to the applicant about an application';
comment on column applicants.city is
  'pii:identity:address — where the office writes to the applicant about an application';
comment on column applicants.province is
  'pii:identity:address — where the office writes to the applicant about an application';
comment on column applicants.postal_code is
  'pii:identity:address — where the office writes to the applicant about an application';

-- Four digits, because a Philippine ZIP is four digits. Checked rather than
-- left free text: an address the office cannot post to is worse than no
-- address, since it is acted on.
