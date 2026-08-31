-- 033_permit_vocabulary.sql
--
-- D-10, ruled by the owner on 31 August 2026: the office's nineteen names are
-- canonical, and eBPCO accepts filings for the three clearances another office
-- issues.
--
-- This table said 'Fencing'. The office's own form says "Fencing Permit
-- Application", the admin portal says 'Fencing Permit', and both citizen
-- clients take their vocabulary from the admin portal. Three front ends spell
-- it the office's way and one table spelled it another; the table moves.
--
-- Migration 002 cannot be edited -- it is already applied everywhere it has
-- ever run -- so this is a new migration that renames what 002 seeded. On a
-- fresh database the two compose to the same nineteen names.
--
-- WHAT THIS REPLACES. Until now the two vocabularies were bridged by a lookup
-- table in the code (`published-vocabulary.ts`), which is a cast: a third
-- spelling with no authority, in a place no client can see. The ruling
-- abolishes it. That file is deleted in the same commit, and a standing gate
-- now asserts this table against the pinned admin vocabulary, so the decision
-- cannot drift back.

begin;

-- 1. The five foreign keys on this primary key are all ON UPDATE NO ACTION, so
--    a bare rename fails on every one of them.
--
--    Four of the five are visible in a grep of `references permit_types`;
--    fee_schedule_entries is NOT -- it declares the key in a later migration in
--    another form. The list below came from pg_constraint against a live
--    database rather than from reading the migrations, which is the only way it
--    is complete.
--
--    Each ON DELETE rule is preserved exactly. document_requirements and
--    staff_permit_access are RESTRICT and must stay RESTRICT: they are what
--    stops a permit type being deleted out from under a requirement or an
--    officer's assignment.

alter table applications
  drop constraint applications_permit_type_fkey,
  add  constraint applications_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on update cascade;

alter table charter_entries
  drop constraint charter_entries_permit_type_fkey,
  add  constraint charter_entries_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on update cascade;

alter table fee_schedule_entries
  drop constraint fee_schedule_entries_permit_type_fkey,
  add  constraint fee_schedule_entries_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on update cascade;

alter table document_requirements
  drop constraint document_requirements_permit_type_fkey,
  add  constraint document_requirements_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on update cascade on delete restrict;

alter table staff_permit_access
  drop constraint staff_permit_access_permit_type_fkey,
  add  constraint staff_permit_access_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on update cascade on delete restrict;

-- 2. Fifteen renames, carried into every referencing row by the cascade above.
--
--    staff_permit_access is NOT empty when this runs: migration 032 grants one
--    row per staff account per permit type, so a freshly seeded super admin
--    already holds seventeen rows that have to travel with the rename. The
--    cascade is what carries them; without it the officer would keep an
--    assignment to a name that no longer exists.
--
--    THE EN DASH. The three building-permit names use U+2013 (-- an en dash,
--    not a hyphen). It is what the admin portal uses and what both citizen
--    clients match on. A hyphen here is a different string and every client
--    would silently fail to match it.

update permit_types set permit_type = 'Building Permit – New Construction'        where permit_type = 'New Construction';
update permit_types set permit_type = 'Building Permit – Renovation / Alteration' where permit_type = 'Renovation';
update permit_types set permit_type = 'Building Permit – Addition / Extension'    where permit_type = 'Addition/Extension';
update permit_types set permit_type = 'Demolition Permit'                         where permit_type = 'Demolition';
update permit_types set permit_type = 'Architectural Permit'                      where permit_type = 'Architectural';
update permit_types set permit_type = 'Civil / Structural Permit'                 where permit_type = 'Civil/Structural';
update permit_types set permit_type = 'Electrical Permit'                         where permit_type = 'Electrical';
update permit_types set permit_type = 'Mechanical Permit'                         where permit_type = 'Mechanical';
update permit_types set permit_type = 'Plumbing Permit'                           where permit_type = 'Plumbing';
update permit_types set permit_type = 'Electronics Permit'                        where permit_type = 'Electronics';
update permit_types set permit_type = 'Interior Design Permit'                    where permit_type = 'Interior Design';
update permit_types set permit_type = 'Fencing Permit'                            where permit_type = 'Fencing';
update permit_types set permit_type = 'Sign Permit'                               where permit_type = 'Sign';
update permit_types set permit_type = 'Excavation Permit'                         where permit_type = 'Excavation';

-- 'Sanitary/Plumbing' -> 'Sanitary Permit'. The one rename that is a ruling
-- rather than a respelling, so it is separated from the fourteen above.
--
-- This service carried both 'Sanitary/Plumbing' and 'Plumbing'; the office
-- carries both 'Sanitary Permit' and 'Plumbing Permit'. One-to-one is the only
-- mapping that orphans neither. It is also what the documents say independently
-- of the ruling: the forms this LGU publishes are NBC FORM NO. A-05 (Sanitary
-- Permit, under the Code on Sanitation of the Philippines) and NBC FORM NO.
-- A-06 (Plumbing Permit, under the Revised Plumbing Code) -- two distinct
-- forms under PD 1096, certified by different licensed professionals. The
-- combined key was stale, not a category of its own.
--
-- The 'SPP' permit-number prefix follows the key to the new name, so permit
-- numbers already issued in that series stay in it.
update permit_types set permit_type = 'Sanitary Permit' where permit_type = 'Sanitary/Plumbing';

-- 3. Three genuinely new rows: the scope half of the ruling. These are issued
--    by the Municipal Planning and Development Office (zoning) and by the
--    Bureau of Fire Protection, a national agency -- not by the OBO. eBPCO
--    accepts the filing and routes it, so a citizen files in one place.
--
--    Both citizen clients already have wizards for all three, which until now
--    a citizen could fill in and not file.
insert into permit_types (permit_type, service_domain) values
  ('Zoning / Locational Clearance',   'Construction Permit'),
  ('FSEC for Building Permit (BFP)',  'Construction Permit'),
  ('FSIC for Occupancy Permit (BFP)', 'Construction Permit');

-- 4. The three new types have to reach an officer's queue, or a citizen files
--    into a black hole.
--
--    Migration 032 granted every staff account every permit type, and the staff
--    queue filters on `staff_permit_access` -- so a permit type nobody is
--    assigned to appears in NO officer's queue, and the lifecycle write check
--    refuses every transition on it. Without this step a citizen could file the
--    zoning clearance the ruling just enabled, and it would sit unread and
--    unactionable for ever. Inserting the type is not the same as opening it.
--
--    Granted ONLY to accounts that already hold every pre-existing type. An
--    officer deliberately narrowed to a subset stays narrowed: widening them is
--    an authorisation decision that belongs to a super admin, not to a
--    migration. An account holding everything holds everything by construction
--    -- that is what 032 did -- so extending it keeps that account exactly as
--    unrestricted as it was, which is the same "preserve today" rule 032 used.
insert into staff_permit_access (account_id, permit_type, granted_by)
select held.account_id, fresh.permit_type, held.account_id
  from (
    select account_id
      from staff_permit_access
     group by account_id
    having count(*) = (
      select count(*) from permit_types
       where permit_type not in ('Zoning / Locational Clearance',
                                 'FSEC for Building Permit (BFP)',
                                 'FSIC for Occupancy Permit (BFP)'))
  ) held
  cross join (values ('Zoning / Locational Clearance'),
                     ('FSEC for Building Permit (BFP)'),
                     ('FSIC for Occupancy Permit (BFP)')) as fresh (permit_type)
on conflict (account_id, permit_type) do nothing;

-- 'Certificate of Occupancy' is already spelled the office's way and is not
-- touched. 'Business Permit' stays: it is not one of the office's nineteen
-- construction permits, and the clients' legacy business-permit flow is a
-- separate open question. Deleting it here would strand that flow.

commit;
