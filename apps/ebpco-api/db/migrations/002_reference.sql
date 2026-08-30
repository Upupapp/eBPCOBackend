-- Reference data: the vocabulary of record, and the LGU-published data the
-- pledge clock and every fee are built on.
--
-- These are tables rather than enum types on purpose. The lifecycle statuses
-- need to be referenced by a transitions table with real foreign keys, and the
-- Citizen's Charter data is effective-dated LGU-published material that changes
-- without a code deploy.

create table lifecycle_statuses (
  status       text    primary key,
  -- Position on the happy path, or null for the states that are not on it:
  -- Revision Required loops back into evaluation, and the terminal exits are
  -- reachable from most states rather than sitting at a position.
  sequence     integer unique,
  terminal     boolean not null default false,
  -- The applicant-visible projection. Held here so the database and the
  -- contract's lifecycle-projection.json cannot disagree.
  applicant_status text not null,
  requires_applicant_action boolean not null default false
);

insert into lifecycle_statuses (status, sequence, terminal, applicant_status, requires_applicant_action) values
  ('Draft',                       1,  false, 'Draft',                false),
  ('Submitted',                   2,  false, 'Submitted',            false),
  ('Received',                    3,  false, 'Submitted',            false),
  ('Document Verification',       4,  false, 'Under Review',         false),
  ('Under Evaluation',            5,  false, 'Under Review',         false),
  ('Revision Required',        null,  false, 'Under Review',         true),
  ('Assessed',                    6,  false, 'Payment Verification', true),
  ('Payment Submitted',           7,  false, 'Payment Verification', false),
  ('Payment Under Verification',  8,  false, 'Payment Verification', false),
  ('Payment Verified',            9,  false, 'Payment Verification', false),
  ('For Approval',               10,  false, 'Payment Verification', false),
  ('Approved',                   11,  false, 'Approved',             false),
  ('Permit Generated',           12,  false, 'Approved',             false),
  ('Ready for Release',          13,  false, 'Ready for Release',    true),
  ('Released',                   14,  false, 'Ready for Release',    false),
  ('Completed',                  15,  true,  'Ready for Release',    false),
  ('Rejected',                 null,  true,  'Rejected',             false),
  ('Cancelled',                null,  true,  'Rejected',             false),
  ('Expired',                  null,  true,  'Rejected',             false);

-- The legal moves, as data. An officer cannot jump an application from
-- Submitted to Released because a UI bug allowed it: the trigger in migration
-- 003 consults this table on every status change.
create table lifecycle_transitions (
  from_status  text not null references lifecycle_statuses (status),
  to_status    text not null references lifecycle_statuses (status),
  primary key (from_status, to_status),
  constraint transition_is_a_move check (from_status <> to_status)
);

insert into lifecycle_transitions (from_status, to_status) values
  ('Draft', 'Submitted'), ('Draft', 'Cancelled'),
  ('Submitted', 'Received'), ('Submitted', 'Cancelled'),
  ('Received', 'Document Verification'), ('Received', 'Cancelled'),
  ('Document Verification', 'Under Evaluation'),
  ('Document Verification', 'Revision Required'),
  ('Document Verification', 'Rejected'),
  ('Under Evaluation', 'Assessed'),
  ('Under Evaluation', 'Revision Required'),
  ('Under Evaluation', 'Rejected'),
  ('Revision Required', 'Under Evaluation'),
  ('Revision Required', 'Cancelled'),
  ('Revision Required', 'Expired'),
  ('Assessed', 'Payment Submitted'), ('Assessed', 'Cancelled'), ('Assessed', 'Expired'),
  ('Payment Submitted', 'Payment Under Verification'),
  ('Payment Under Verification', 'Payment Verified'),
  ('Payment Under Verification', 'Payment Submitted'),
  ('Payment Verified', 'For Approval'),
  ('For Approval', 'Approved'),
  ('For Approval', 'Revision Required'),
  ('For Approval', 'Rejected'),
  ('Approved', 'Permit Generated'),
  ('Permit Generated', 'Ready for Release'),
  ('Ready for Release', 'Released'),
  ('Released', 'Completed');

-- A terminal status must have no way out. Asserted at migration time rather
-- than trusted, because the two lists above are maintained by hand.
do $$
declare escaping text;
begin
  select string_agg(t.from_status, ', ') into escaping
  from lifecycle_transitions t
  join lifecycle_statuses s on s.status = t.from_status
  where s.terminal;

  if escaping is not null then
    raise exception 'terminal statuses have onward transitions: %', escaping;
  end if;
end $$;

create table permit_types (
  permit_type    text primary key,
  service_domain text not null check (service_domain in ('Business Permit', 'Construction Permit'))
);

insert into permit_types (permit_type, service_domain) values
  ('New Construction', 'Construction Permit'), ('Renovation', 'Construction Permit'),
  ('Addition/Extension', 'Construction Permit'), ('Demolition', 'Construction Permit'),
  ('Architectural', 'Construction Permit'), ('Civil/Structural', 'Construction Permit'),
  ('Electrical', 'Construction Permit'), ('Mechanical', 'Construction Permit'),
  ('Sanitary/Plumbing', 'Construction Permit'), ('Plumbing', 'Construction Permit'),
  ('Electronics', 'Construction Permit'), ('Interior Design', 'Construction Permit'),
  ('Fencing', 'Construction Permit'), ('Sign', 'Construction Permit'),
  ('Excavation', 'Construction Permit'), ('Certificate of Occupancy', 'Construction Permit'),
  ('Business Permit', 'Business Permit');

-- Effective-dated, so a historical assessment can be explained against the
-- schedule that was in force when it was made. LGU-published (M-08): this table
-- ships EMPTY and is loaded from the LGU's Citizen's Charter. An application
-- whose permit type has no row here gets no countdown at all, and the clients
-- say "Awaiting classification" rather than inventing a pledge.
create table charter_entries (
  id                   uuid    primary key default gen_random_uuid(),
  permit_type          text    not null references permit_types (permit_type),
  classification       text    not null check (classification in ('Simple', 'Complex', 'Highly Technical')),
  pledged_working_days integer not null check (pledged_working_days > 0),
  effective_from       date    not null,
  effective_to         date,
  fee_schedule_version text    not null,
  legal_basis          text,

  constraint charter_effective_range check (effective_to is null or effective_to > effective_from)
);

-- One entry in force per permit type at a time. Overlapping rows would make
-- "what did we pledge" unanswerable.
create unique index charter_one_in_force_idx
  on charter_entries (permit_type, effective_from);

create table holiday_calendars (
  year      integer primary key check (year between 2020 and 2100),
  -- False until the year's proclamation is issued in full. The movable Islamic
  -- holidays are proclaimed during the year (M-12), and a false value forces
  -- the pledge to be presented as approximate rather than asserted.
  complete  boolean not null default false
);

create table holidays (
  year          integer not null references holiday_calendars (year) on delete cascade,
  holiday_date  date    not null,
  name          text    not null,
  kind          text    not null check (kind in ('Regular Holiday', 'Special Non-Working Day', 'Local Holiday')),
  proclamation  text,
  primary key (year, holiday_date),

  constraint holiday_belongs_to_its_year check (extract(year from holiday_date) = year)
);
