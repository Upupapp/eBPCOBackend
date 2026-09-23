-- `lifecycle_transitions` is the runtime authority (D-5) -- the compiled
-- TRANSITIONS table in domain/lifecycle.ts is only the seed's starting
-- point and is not consulted by LifecycleService.transition() at all. So
-- widening `actors` there, alone, changes nothing a real deployment does;
-- this migration is the other half of that edit.
--
-- A walk-in's draft is started by an officer at the counter
-- (SubmissionService.fileOnBehalf with saveAsDraft), and per the save-draft
-- feature's design it must be resumable and finalisable by ANY officer, not
-- only the one who began it -- so 'staff' joins 'applicant' as a legal
-- actor on both moves a Draft can make. Nothing else about either rule
-- changes: same scope, same preconditions, same notification. A staff
-- caller is still checked against their own staff_permit_access by
-- LifecycleService.transition() before this rule is even consulted, so
-- this does not broaden what an officer can act on beyond their own
-- assigned permit types.
update lifecycle_transitions set actors = array['applicant', 'staff']
  where from_status = 'Draft' and to_status = 'Submitted';
update lifecycle_transitions set actors = array['applicant', 'staff']
  where from_status = 'Draft' and to_status = 'Cancelled';
