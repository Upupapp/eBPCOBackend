-- What a Renewal or Amendment renews when eBPCO never issued it.
--
-- `renews_permit_id` (024) is a foreign key on purpose: a link that cannot
-- point at a permit the LGU never issued. That is exactly right for a permit
-- eBPCO itself generated, and exactly wrong for the common case this system
-- launched into — a citizen holding a real, physical permit the Municipality
-- issued before eBPCO existed, with no row in `generated_permits` for it at
-- all. Until now such a citizen had no path: the wizard and the walk-in
-- counter both insist on a permit number that resolves, and refuse outright
-- when it does not.
--
-- This is a second, deliberately weaker reference for that case: a plain
-- text claim, never resolved against `generated_permits`, never treated as
-- verified. The officer judges it from the proof document the applicant is
-- required to attach alongside it (see the document_requirements seeded
-- below) — the same "give the officer the fact, let them decide" shape the
-- 3 Sept 2026 renewal-reuse ruling already established for reused documents.
alter table applications add column prior_permit_claim text;

comment on column applications.prior_permit_claim is
  'A permit number the applicant SAYS the Municipality issued before eBPCO existed. Self-reported and never verified against generated_permits -- staff judge it from the attached prior-permit-proof document. Null unless application_action <> ''New'' and renews_permit_id is null.';

-- Widened, not loosened: a Renewal/Amendment must still name SOMETHING it
-- acts on. It may now be either kind of reference -- the verified
-- `renews_permit_id` or the unverified `prior_permit_claim` -- rather than
-- only the first. Holding both at once is refused by the service, not this
-- constraint: which one should win is a service-level judgement call, not a
-- fact about the row's shape.
alter table applications drop constraint renewal_names_what_it_renews;
alter table applications add constraint renewal_names_what_it_renews check (
  (application_action = 'New' and renews_permit_id is null and prior_permit_claim is null)
  or (application_action <> 'New' and (renews_permit_id is not null or prior_permit_claim is not null))
);

-- The proof document every prior-permit claim needs. `required = false` at
-- the catalog level because this table is a pure function of (permit_type,
-- application_action) — it has no notion of "this particular citizen has
-- nothing on file to link instead." The actual requiredness lives in
-- SubmissionService, which refuses a claim filed with no document carrying
-- this code. One code, reused across every permit type and both actions —
-- the same `application_action`-scoped shape migration 047 established for
-- Building Permit, applied here across all nineteen.
insert into document_requirements (permit_type, code, label, description, required, position, application_action)
select permit_types.permit_type,
       'prior-permit-proof',
       'Copy of your existing/prior permit',
       'Only needed if the permit you are renewing or amending was issued by the Municipality before eBPCO existed, so it does not appear in the system to select automatically. Upload a clear photo or scan of the permit.',
       false,
       999,
       action
  from permit_types, unnest(array['Renewal', 'Amendment']) as action;
