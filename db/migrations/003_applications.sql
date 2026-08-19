-- Applicants, businesses, and the application record itself.

create table applicants (
  id           uuid        primary key default gen_random_uuid(),
  account_id   uuid        not null unique references accounts (id) on delete restrict,
  first_name   text        not null,
  last_name    text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on column applicants.first_name is 'pii:identity:name — lawful basis: performance of a public task (PD 1096 permit issuance)';
comment on column applicants.last_name  is 'pii:identity:name — lawful basis: performance of a public task (PD 1096 permit issuance)';

-- `on delete restrict`, not cascade: an erasure request must not silently take
-- filed permit applications with it. RA 10173's right to erasure yields to the
-- LGU's retention obligation over issued permits, and that conflict is resolved
-- explicitly by the retention job, not implicitly by a foreign key.

create table businesses (
  id                  uuid        primary key default gen_random_uuid(),
  owner_applicant_id  uuid        not null references applicants (id) on delete restrict,
  name                text        not null,
  category            text        not null check (category in
                        ('Retail', 'Food Service', 'Services', 'Manufacturing', 'Wholesale', 'Other')),
  street              text        not null,
  barangay            text        not null,
  city                text        not null,
  province            text        not null,
  registration_number text        not null,
  date_registered     date        not null,
  status              text        not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column businesses.street   is 'pii:identity:address — business address, also frequently a home address';
comment on column businesses.barangay is 'pii:identity:address — business address, also frequently a home address';

create index businesses_owner_idx on businesses (owner_applicant_id);

create table applications (
  id                  uuid        primary key default gen_random_uuid(),

  -- Human-facing, and separate from the id on purpose: an applicant quotes this
  -- at a counter, and a UUID is unusable spoken aloud.
  reference_number    text        not null unique,

  applicant_id        uuid        not null references applicants (id) on delete restrict,
  business_id         uuid        references businesses (id) on delete restrict,

  permit_type         text        not null references permit_types (permit_type),
  application_action  text        not null check (application_action in ('New', 'Renewal', 'Amendment')),
  location            text,

  -- The truth. Everything the applicant and the officer see is projected from
  -- this one column by the lifecycle_statuses table, so the two clients cannot
  -- describe the same record differently.
  lifecycle_status    text        not null default 'Draft' references lifecycle_statuses (status),

  -- Assigned by the server from the Citizen's Charter. Null where the charter
  -- has no entry, which is what produces "Awaiting classification" rather than
  -- a guessed deadline.
  classification      text        check (classification in ('Simple', 'Complex', 'Highly Technical')),
  charter_entry_id    uuid        references charter_entries (id),

  -- RA 11032 excludes time the applicant is responding to a deficiency. Set
  -- when the application enters Revision Required, cleared on resubmission.
  pledge_suspended_since timestamptz,

  -- Optimistic concurrency. Two officers acting on one record produce a
  -- conflict rather than a lost update.
  version             integer     not null default 1,

  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        references accounts (id),
  updated_by          uuid        references accounts (id),

  -- A filed application has a filing date; a draft does not.
  constraint submitted_at_matches_status check (
    (lifecycle_status = 'Draft' and submitted_at is null)
    or (lifecycle_status <> 'Draft' and submitted_at is not null)
  )
);

create index applications_applicant_idx on applications (applicant_id);
create index applications_status_idx    on applications (lifecycle_status);
-- The officer queue: everything not finished, oldest first.
create index applications_open_idx      on applications (submitted_at)
  where lifecycle_status not in ('Draft', 'Completed', 'Rejected', 'Cancelled', 'Expired');

-- Every movement, append-only. The timeline both clients render.
create table application_transitions (
  id               uuid        primary key default gen_random_uuid(),
  application_id   uuid        not null references applications (id) on delete restrict,
  from_status      text        references lifecycle_statuses (status),
  to_status        text        not null references lifecycle_statuses (status),
  occurred_at      timestamptz not null default now(),
  actor_account_id uuid        references accounts (id),
  office           text,
  -- The evaluator's words. Rendered verbatim by both clients; never summarised.
  remarks          text
);

create index application_transitions_app_idx on application_transitions (application_id, occurred_at);

-- ── The constraint that matters ──────────────────────────────────────────
--
-- An illegal lifecycle transition is rejected by the DATABASE, not merely by
-- the service. Both clients advanced status locally before this programme
-- started, and the lifecycle engine in TAB 05 will enforce the same rule --
-- but a rule enforced only in application code is a rule that a migration
-- script, a psql session, or a second service can walk straight past.
create or replace function enforce_lifecycle_transition() returns trigger as $$
begin
  if new.lifecycle_status = old.lifecycle_status then
    return new;
  end if;

  if not exists (
    select 1 from lifecycle_transitions
    where from_status = old.lifecycle_status
      and to_status   = new.lifecycle_status
  ) then
    raise exception 'illegal lifecycle transition: % -> %', old.lifecycle_status, new.lifecycle_status
      using errcode = 'check_violation';
  end if;

  -- Every movement leaves a trace, whoever made it and however.
  insert into application_transitions (application_id, from_status, to_status, actor_account_id)
  values (new.id, old.lifecycle_status, new.lifecycle_status, new.updated_by);

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger applications_enforce_transition
  before update of lifecycle_status on applications
  for each row execute function enforce_lifecycle_transition();

-- A new application starts at Draft or Submitted and nowhere else. Without
-- this, an insert could place a record directly into 'Approved' and skip every
-- transition check above it.
create or replace function enforce_initial_status() returns trigger as $$
begin
  if new.lifecycle_status not in ('Draft', 'Submitted') then
    raise exception 'an application may not be created at status %', new.lifecycle_status
      using errcode = 'check_violation';
  end if;
  insert into application_transitions (application_id, from_status, to_status, actor_account_id)
  values (new.id, null, new.lifecycle_status, new.created_by);
  return new;
end;
$$ language plpgsql;

create trigger applications_enforce_initial_status
  after insert on applications
  for each row execute function enforce_initial_status();
