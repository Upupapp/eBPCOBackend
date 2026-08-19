-- Human-facing document numbers, issued atomically.
--
-- A permit number and an Order of Payment number are read aloud at a counter,
-- written on a form, and quoted in a complaint. Two of the same number is not a
-- display bug: it is two buildings whose paperwork cannot be told apart, or two
-- payments the Treasurer cannot reconcile.
--
-- The first version of the permit numbering counted existing rows and added
-- one. That is wrong twice. It collides the moment any number in the table did
-- not come from the counter -- a migrated record, a manually corrected one --
-- and it is not safe under concurrency, because two officers approving at the
-- same instant read the same count. The row lock the service already held was
-- on `applications`, and two different applications take two different locks.
--
-- This table is the counter. The upsert below is a single statement, so
-- PostgreSQL serialises it on the primary key and there is no window between
-- reading and incrementing.
create table document_number_sequences (
  -- The series a number belongs to. Separate per year AND per prefix, because
  -- an LGU numbers its fencing permits and its building permits independently
  -- and restarts both in January.
  series      text    not null,
  year        integer not null check (year between 2020 and 2100),
  last_issued integer not null default 0 check (last_issued >= 0),

  primary key (series, year)
);

comment on table document_number_sequences is
  'Atomic counters for human-facing document numbers. Increment with the upsert in '
  'PermitService.generate — never by reading and writing separately.';

-- Seeded from what is already in the table, so a database that was migrated or
-- hand-corrected does not start reissuing numbers that exist. Reading the
-- maximum ONCE here is safe in a way that reading it per issue is not: a
-- migration runs alone, before the new version serves anything.
insert into document_number_sequences (series, year, last_issued)
select
  split_part(permit_number, '-', 1) as series,
  split_part(permit_number, '-', 2)::integer as year,
  max(split_part(permit_number, '-', 3)::integer) as last_issued
from generated_permits
where permit_number ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'
group by 1, 2;
