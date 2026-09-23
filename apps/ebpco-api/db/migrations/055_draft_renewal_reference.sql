-- Widens renewal_names_what_it_renews (024, last rewritten by 053) to admit
-- the one new shape the save-draft feature introduces: a Renewal/Amendment
-- Draft that names neither reference yet. Found by a failing test, not by
-- inspection -- SubmissionService.resolveRenewal()'s tolerateNoReferenceYet
-- already let this row past the SERVICE, and the database's own independent
-- copy of the same rule (this constraint) rejected the insert anyway.
--
-- Still refused for anything that is not a Draft: a FILED Renewal/Amendment
-- must name what it renews, exactly as before. And a New application still
-- may never carry either reference, in any status -- resolveRenewal() itself
-- refuses that one before a row is ever written, so this constraint never
-- has to.
alter table applications drop constraint renewal_names_what_it_renews;
alter table applications add constraint renewal_names_what_it_renews check (
  (application_action = 'New' and renews_permit_id is null and prior_permit_claim is null)
  or (application_action <> 'New'
      and (renews_permit_id is not null or prior_permit_claim is not null or lifecycle_status = 'Draft'))
);
