-- Closes a real gap: `Ready for Release -> Released` checked only
-- `permit-generated` -- the same fact the PREVIOUS hop already checked -- and
-- never confirmed the release itself had actually happened. An officer
-- holding `staff:release` could call the generic transition endpoint
-- directly and skip `POST .../release` entirely, leaving the application
-- showing as Released with no claimant name, method, or releasing officer
-- ever recorded in `permit_releases`.
--
-- The `permit_releases_require_permit` trigger (migration 005) only guards
-- THAT table reaching status='Released' -- it has no say over
-- `applications.lifecycle_status`, since nothing ties the two columns
-- together. This precondition is what ties them together.
--
-- Same idiom as the `permit-generated` precondition already on this table:
-- lifecycle.service.ts's SNAPSHOT_SQL gets a matching `permit_released`
-- exists-check reading `permit_releases.released_at`.
update lifecycle_transitions
   set preconditions = array['permit-generated', 'permit-released']
 where from_status = 'Ready for Release' and to_status = 'Released';
