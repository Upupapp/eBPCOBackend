-- The lifecycle becomes configuration.
--
-- Owner decision, D-5, 2026-08-29: fully editable — the graph AND the rule on
-- each edge. `lifecycle_transitions` already held the graph and the trigger has
-- always read it; what was compiled into TypeScript was everything that makes a
-- move mean something: who may make it, what scope it needs, what must be true
-- first, and what the applicant is told.
--
-- ── What this gives away, recorded once ─────────────────────────────────
--
-- The separation-of-duty rules built across TABs 00-07 become editable by the
-- people they constrain. An LGU can set 'Payment Verified' -> 'For Approval' to
-- require `applications:read` and every officer can then approve. That is the
-- consequence of the decision, not an oversight, and it is why every change
-- here is audited and why an edit that weakens a control is FLAGGED in the
-- response rather than accepted in silence.
--
-- What is NOT given away is reachability. An edit that strands an application
-- in a status with no legal move out is a correctness failure nobody chooses,
-- and it is refused.
alter table lifecycle_transitions
  -- 'applicant', 'staff', or both. Stored as an array because a move may be
  -- open to either, and a boolean pair would make "neither" expressible.
  add column actors text[] not null default array['staff'],
  add column requires_scope text not null default 'applications:write',
  add column preconditions text[] not null default '{}',
  -- The catalogue type this move produces, or null for a move that tells the
  -- applicant nothing. Eight moves are genuinely silent.
  add column notifies text,
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references accounts (id) on delete restrict,
  -- Display order, and nothing more. The rules are a set; the ORDER they are
  -- listed in is what a flow chart reads as a process rather than an index, and
  -- a set has no order to recover once the authored array is gone. Written from
  -- the position in the submitted array, so an editor reorders the moves by
  -- reordering them -- there is no extra field on the wire.
  add column ordinal int not null default 0;

alter table lifecycle_transitions add constraint transition_has_an_actor check (
  cardinality(actors) > 0
  and actors <@ array['applicant', 'staff']
);

-- Seeded from the compiled table, which becomes the STARTING POINT rather than
-- the authority.
--
-- GENERATED from `TRANSITIONS` rather than hand-written, and that is not
-- fastidiousness: the hand-written version was wrong on seventeen of the
-- thirty-two moves — scopes, preconditions and actors that I had described from
-- memory instead of read. A seed that quietly differs from the rules the engine
-- applies would change how permits are processed on the day it was applied and
-- nothing would say so. The spec beside this compares the two, so the day the
-- compiled table changes without this one, a test fails.
update lifecycle_transitions set ordinal = 0, actors = array['applicant'], requires_scope = 'applications:write', preconditions = array['identity-document-verified', 'required-documents-present'], notifies = 'application-submitted'
  where from_status = 'Draft' and to_status = 'Submitted';
update lifecycle_transitions set ordinal = 1, actors = array['applicant'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Draft' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 2, actors = array['staff'], requires_scope = 'applications:read', preconditions = '{}', notifies = 'received-by-obo'
  where from_status = 'Submitted' and to_status = 'Received';
update lifecycle_transitions set ordinal = 3, actors = array['applicant', 'staff'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Submitted' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 4, actors = array['staff'], requires_scope = 'documents:read', preconditions = '{}', notifies = 'document-verification-started'
  where from_status = 'Received' and to_status = 'Document Verification';
update lifecycle_transitions set ordinal = 5, actors = array['applicant', 'staff'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Received' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 6, actors = array['staff'], requires_scope = 'staff:evaluate', preconditions = array['identity-document-verified', 'required-documents-present'], notifies = null
  where from_status = 'Document Verification' and to_status = 'Under Evaluation';
update lifecycle_transitions set ordinal = 7, actors = array['staff'], requires_scope = 'staff:evaluate', preconditions = '{}', notifies = 'revision-required'
  where from_status = 'Document Verification' and to_status = 'Revision Required';
update lifecycle_transitions set ordinal = 8, actors = array['staff'], requires_scope = 'staff:approve', preconditions = '{}', notifies = 'rejected'
  where from_status = 'Document Verification' and to_status = 'Rejected';
update lifecycle_transitions set ordinal = 9, actors = array['staff'], requires_scope = 'staff:assess', preconditions = array['evaluations-complete', 'order-of-payment-issued'], notifies = 'order-of-payment-issued'
  where from_status = 'Under Evaluation' and to_status = 'Assessed';
update lifecycle_transitions set ordinal = 10, actors = array['staff'], requires_scope = 'staff:evaluate', preconditions = '{}', notifies = 'revision-required'
  where from_status = 'Under Evaluation' and to_status = 'Revision Required';
update lifecycle_transitions set ordinal = 11, actors = array['staff'], requires_scope = 'staff:approve', preconditions = '{}', notifies = 'rejected'
  where from_status = 'Under Evaluation' and to_status = 'Rejected';
update lifecycle_transitions set ordinal = 12, actors = array['applicant'], requires_scope = 'applications:write', preconditions = array['all-instructions-resolved'], notifies = null
  where from_status = 'Revision Required' and to_status = 'Under Evaluation';
update lifecycle_transitions set ordinal = 13, actors = array['applicant', 'staff'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Revision Required' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 14, actors = array['staff'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Revision Required' and to_status = 'Expired';
update lifecycle_transitions set ordinal = 15, actors = array['applicant'], requires_scope = 'payments:write', preconditions = array['order-of-payment-issued', 'payment-proof-submitted'], notifies = 'payment-received'
  where from_status = 'Assessed' and to_status = 'Payment Submitted';
update lifecycle_transitions set ordinal = 16, actors = array['staff'], requires_scope = 'staff:assess', preconditions = '{}', notifies = null
  where from_status = 'Assessed' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 17, actors = array['staff'], requires_scope = 'staff:assess', preconditions = '{}', notifies = null
  where from_status = 'Assessed' and to_status = 'Expired';
update lifecycle_transitions set ordinal = 18, actors = array['staff'], requires_scope = 'staff:verify-payment', preconditions = array['payment-proof-submitted'], notifies = null
  where from_status = 'Payment Submitted' and to_status = 'Payment Under Verification';
update lifecycle_transitions set ordinal = 19, actors = array['staff'], requires_scope = 'staff:verify-payment', preconditions = array['payment-verified'], notifies = 'payment-verified'
  where from_status = 'Payment Under Verification' and to_status = 'Payment Verified';
update lifecycle_transitions set ordinal = 20, actors = array['staff'], requires_scope = 'staff:verify-payment', preconditions = '{}', notifies = null
  where from_status = 'Payment Under Verification' and to_status = 'Payment Submitted';
update lifecycle_transitions set ordinal = 21, actors = array['staff'], requires_scope = 'staff:verify-payment', preconditions = array['payment-verified'], notifies = null
  where from_status = 'Payment Verified' and to_status = 'For Approval';
update lifecycle_transitions set ordinal = 22, actors = array['staff'], requires_scope = 'staff:approve', preconditions = array['payment-verified', 'evaluations-complete'], notifies = 'approved'
  where from_status = 'For Approval' and to_status = 'Approved';
update lifecycle_transitions set ordinal = 23, actors = array['staff'], requires_scope = 'staff:approve', preconditions = '{}', notifies = 'revision-required'
  where from_status = 'For Approval' and to_status = 'Revision Required';
update lifecycle_transitions set ordinal = 24, actors = array['staff'], requires_scope = 'staff:approve', preconditions = '{}', notifies = 'rejected'
  where from_status = 'For Approval' and to_status = 'Rejected';
update lifecycle_transitions set ordinal = 25, actors = array['staff'], requires_scope = 'staff:approve', preconditions = array['permit-generated'], notifies = 'permit-generated'
  where from_status = 'Approved' and to_status = 'Permit Generated';
update lifecycle_transitions set ordinal = 26, actors = array['staff'], requires_scope = 'staff:release', preconditions = array['permit-generated'], notifies = 'ready-for-release'
  where from_status = 'Permit Generated' and to_status = 'Ready for Release';
update lifecycle_transitions set ordinal = 27, actors = array['staff'], requires_scope = 'staff:release', preconditions = array['permit-generated'], notifies = 'released'
  where from_status = 'Ready for Release' and to_status = 'Released';
update lifecycle_transitions set ordinal = 28, actors = array['staff'], requires_scope = 'staff:release', preconditions = '{}', notifies = null
  where from_status = 'Released' and to_status = 'Completed';
