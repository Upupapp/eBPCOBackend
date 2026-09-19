-- 047_consolidate_building_permit.sql
--
-- Consolidates the three Building Permit sub-types D-10 (033) established --
-- "Building Permit – New Construction", "Building Permit – Renovation /
-- Alteration", "Building Permit – Addition / Extension" -- into one
-- published permit type, 'Building Permit'. Directed by the product owner,
-- 2026-09-19: three catalogue boxes for what applicants experience as one
-- permit, with the real document checklists varying by WHAT IS BEING FILED
-- (a new build, a renewal, an amendment) rather than by a permit-type name.
-- The three checklists are preserved verbatim; they now carry
-- `application_action` instead of a distinct permit_type. Mapping follows
-- the order the owner gave the three names in: New Construction -> 'New',
-- Renovation / Alteration -> 'Renewal', Addition / Extension -> 'Amendment'
-- -- the same three values `applications.application_action` has checked
-- against since migration 003.
--
-- WHY a rename-then-repoint, not three deletes-and-reinserts. permit_types
-- (033) already made every FK on this key ON UPDATE CASCADE for exactly
-- this kind of restructuring. Renaming 'Building Permit – New Construction'
-- to 'Building Permit' lets that cascade carry every real reference -- zero
-- real applications reference any of the three today, but a live
-- staff_permit_access grant does -- across automatically. The other two
-- names cannot both be renamed onto the same primary key at once (a PK
-- collision on permit_types itself), so their child rows are repointed by
-- hand below and the two now-empty permit_types rows are deleted last.
--
-- document_requirements' old primary key (permit_type, code) cannot hold
-- what 'Building Permit' now needs: the Renovation/Alteration and
-- Addition/Extension checklists share five codes verbatim -- land-title,
-- owner-consent, brgy-clearance, locational, valid-id (043) -- so a plain
-- (permit_type, code) key would collide the moment both land under one
-- permit_type. `application_action` becomes part of the row's identity
-- instead, via two partial unique indexes: one for the sixteen permit
-- types that have never distinguished by action (application_action is
-- null there, same as before this migration), one for 'Building Permit',
-- which now carries up to three rows per code -- one per action. No other
-- table has an FK into document_requirements (confirmed against a live
-- pg_constraint listing when 022 and 033 were written), so its primary key
-- is free to restructure.

begin;

alter table document_requirements
  add column application_action text
    check (application_action in ('New', 'Renewal', 'Amendment'));

comment on column document_requirements.application_action is
  'Which application action (New/Renewal/Amendment) this requirement applies to. Null means it applies regardless of action -- true for every permit type except Building Permit, the one restructuring (047) needed this for.';

alter table document_requirements drop constraint document_requirements_pkey;
alter table document_requirements add column id uuid not null default gen_random_uuid();
alter table document_requirements add primary key (id);

-- One row per (permit_type, code) where action does not distinguish them --
-- unchanged behaviour for every permit type but the one below.
create unique index document_requirements_no_action_uq
  on document_requirements (permit_type, code) where application_action is null;

-- Up to one row per (permit_type, code, action) where it does.
create unique index document_requirements_with_action_uq
  on document_requirements (permit_type, code, application_action) where application_action is not null;

-- 1. Rename the surviving row. Cascades applications, charter_entries,
--    fee_schedule_entries, document_requirements and staff_permit_access
--    from the old name to 'Building Permit' in the same statement.
update permit_types set permit_type = 'Building Permit'
 where permit_type = 'Building Permit – New Construction';

-- 2. Tag its now-cascaded document_requirements rows with the action they
--    were always New Construction's. Nothing else is 'Building Permit' yet
--    at this point, so this cannot collide with the partial index above.
update document_requirements set application_action = 'New'
 where permit_type = 'Building Permit' and application_action is null;

-- 3. Repoint and tag the other two sub-types' requirements in the SAME
--    statement that changes permit_type, so no row is ever transiently
--    ('Building Permit', <code>, null) while another row already holds
--    that identity.
update document_requirements set permit_type = 'Building Permit', application_action = 'Renewal'
 where permit_type = 'Building Permit – Renovation / Alteration';

update document_requirements set permit_type = 'Building Permit', application_action = 'Amendment'
 where permit_type = 'Building Permit – Addition / Extension';

-- 4. Fee schedule: identical placeholder figures under every permit type
--    today (044) -- repointing would collide on (version, permit_type,
--    line), and there is no real distinct figure to lose. Drop the two
--    now-redundant sets; 'Building Permit' already carries New
--    Construction's, cascaded in step 1.
delete from fee_schedule_entries
 where permit_type in ('Building Permit – Renovation / Alteration', 'Building Permit – Addition / Extension');

-- 5. Staff access: the one live grant-holder (032's seeded super admin)
--    already holds 'Building Permit' via the step-1 cascade. Drop the two
--    now-redundant grants rather than repoint them into a primary-key
--    collision on (account_id, permit_type).
delete from staff_permit_access
 where permit_type in ('Building Permit – Renovation / Alteration', 'Building Permit – Addition / Extension');

-- 6. charter_entries and applications: confirmed empty for both retiring
--    names on the live database when this was written. Nothing to
--    repoint -- and if a row had landed between that check and this
--    running, step 7's ON DELETE RESTRICT stops the migration rather than
--    silently orphaning it.

-- 7. The two retiring rows now have nothing referencing them.
delete from permit_types
 where permit_type in ('Building Permit – Renovation / Alteration', 'Building Permit – Addition / Extension');

commit;
