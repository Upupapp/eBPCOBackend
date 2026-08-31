-- Reversal for 033_permit_vocabulary.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file in the migrations directory that does not match NNN_name.sql, so a
-- rollback script filed beside the migrations would stop every deployment.
--
-- NOT a down-migration and not run by the migrator. This is the SQL an operator
-- would run by hand.
--
-- WHERE IT IS LOSSY, and this one genuinely is. The three rows 033 inserts are
-- new permit types a citizen can file against. If any application, charter
-- entry, fee schedule entry or officer assignment references one of them, the
-- deletes below FAIL rather than destroying it -- document_requirements and
-- staff_permit_access are ON DELETE RESTRICT, and applications has no cascade.
-- That failure is the correct outcome: reversing the scope half of the ruling
-- after a citizen has filed a zoning clearance means deciding what happens to
-- that filing, which is not a decision a rollback script gets to make silently.
--
-- The fifteen renames reverse cleanly. The foreign keys are returned to
-- ON UPDATE NO ACTION, which is how 002 and 032 declared them.

begin;

-- 1. The renames, back. The ON UPDATE CASCADE added by 033 is still in force
--    here and carries the referencing rows back with them.
update permit_types set permit_type = 'New Construction'   where permit_type = 'Building Permit – New Construction';
update permit_types set permit_type = 'Renovation'         where permit_type = 'Building Permit – Renovation / Alteration';
update permit_types set permit_type = 'Addition/Extension' where permit_type = 'Building Permit – Addition / Extension';
update permit_types set permit_type = 'Demolition'         where permit_type = 'Demolition Permit';
update permit_types set permit_type = 'Architectural'      where permit_type = 'Architectural Permit';
update permit_types set permit_type = 'Civil/Structural'   where permit_type = 'Civil / Structural Permit';
update permit_types set permit_type = 'Electrical'         where permit_type = 'Electrical Permit';
update permit_types set permit_type = 'Mechanical'         where permit_type = 'Mechanical Permit';
update permit_types set permit_type = 'Sanitary/Plumbing'  where permit_type = 'Sanitary Permit';
update permit_types set permit_type = 'Plumbing'           where permit_type = 'Plumbing Permit';
update permit_types set permit_type = 'Electronics'        where permit_type = 'Electronics Permit';
update permit_types set permit_type = 'Interior Design'    where permit_type = 'Interior Design Permit';
update permit_types set permit_type = 'Fencing'            where permit_type = 'Fencing Permit';
update permit_types set permit_type = 'Sign'               where permit_type = 'Sign Permit';
update permit_types set permit_type = 'Excavation'         where permit_type = 'Excavation Permit';

-- 2. The officer assignments 033 created for the three new types. Removed
--    first: staff_permit_access is ON DELETE RESTRICT, so the delete below
--    would fail on them -- and unlike an application or a requirement, an
--    assignment this script created itself is not somebody's work to preserve.
delete from staff_permit_access where permit_type in (
  'Zoning / Locational Clearance',
  'FSEC for Building Permit (BFP)',
  'FSIC for Occupancy Permit (BFP)');

-- 2. The three new types. These FAIL if anything references them -- see above.
delete from permit_types where permit_type in (
  'Zoning / Locational Clearance',
  'FSEC for Building Permit (BFP)',
  'FSIC for Occupancy Permit (BFP)');

-- 3. The foreign keys, back to ON UPDATE NO ACTION as 002 and 032 declared
--    them, each keeping its own ON DELETE rule.
alter table applications
  drop constraint applications_permit_type_fkey,
  add  constraint applications_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type);

alter table charter_entries
  drop constraint charter_entries_permit_type_fkey,
  add  constraint charter_entries_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type);

alter table fee_schedule_entries
  drop constraint fee_schedule_entries_permit_type_fkey,
  add  constraint fee_schedule_entries_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type);

alter table document_requirements
  drop constraint document_requirements_permit_type_fkey,
  add  constraint document_requirements_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on delete restrict;

alter table staff_permit_access
  drop constraint staff_permit_access_permit_type_fkey,
  add  constraint staff_permit_access_permit_type_fkey
       foreign key (permit_type) references permit_types (permit_type)
       on delete restrict;

delete from schema_migrations where version = 33;

commit;
