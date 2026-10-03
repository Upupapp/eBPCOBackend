-- Findings from the 2026-10-03 QA run on the custom domains, the ones the
-- database has to carry.

-- ── A draft is numbered when it is filed (TC-37) ───────────────────────────
-- A draft used to take the next E-BPCO number the moment it was first saved,
-- so every abandoned draft left a gap in the official series. Drafts now
-- carry a temporary DRAFT-… label (submission.service.ts) and take their
-- number when they move to Submitted (lifecycle.service.ts), from this one
-- function, which every filing shares.
create or replace function next_application_reference(p_at timestamptz) returns text as $$
declare
  v_year int := extract(year from p_at at time zone 'UTC');
  v_last bigint;
begin
  insert into document_number_sequences (series, year, last_issued)
  values ('APP', v_year, 1)
  on conflict (series, year)
    do update set last_issued = document_number_sequences.last_issued + 1
  returning last_issued into v_last;
  return 'E-BPCO-' || v_year || '-' || lpad(v_last::text, 6, '0');
end;
$$ language plpgsql;

-- ── What an issued permit says about itself (TC-04, TC-18) ─────────────────
-- Until now generated_permits had nowhere to keep how long the permit is
-- valid, who approved it or for which office, so every permit printed
-- "Not recorded by the office" on all three. Nullable: the permits issued
-- before this were issued without them, and nothing can recover them now.
alter table generated_permits
  add column expires_on         date,
  add column approving_official text,
  add column approving_office   text;

comment on column generated_permits.expires_on is
  'The last day the permit is valid, as the Building Official set it when generating the permit.';
comment on column generated_permits.approving_official is
  'The official who approved the permit, as printed on it.';
comment on column generated_permits.approving_office is
  'The office that issued the permit, as printed on it.';

-- ── Who a permit was handed to, and on what proof (TC-14) ─────────────────
alter table permit_releases
  add column id_presented            text,
  add column authorization_reference text;

comment on column permit_releases.id_presented is
  'pii:identity:document — the ID the claimant presented when collecting the permit (type and number).';
comment on column permit_releases.authorization_reference is
  'pii:identity:document — for a representative: the authorization they presented (a letter or SPA, and from whom).';

-- ── A new account request reaches the Super Admin (TC-13) ──────────────────
insert into staff_notification_types (type, requires_act) values
  ('access-requested', true);
