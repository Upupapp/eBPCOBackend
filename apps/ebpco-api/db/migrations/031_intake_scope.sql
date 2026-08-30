-- `staff:receive`, and the two intake transitions regated onto it.
--
-- Both were gated on READ scopes -- `Submitted -> Received` on
-- `applications:read`, `Received -> Document Verification` on `documents:read`
-- -- because `receiving-officer` was the only acting role with no acting scope,
-- so the rules had nothing stronger to name.
--
-- A read scope authorising a state change grants that change to everyone
-- holding it, and `auditor` holds both by design. The
-- read-everything-change-nothing role could move an application through intake.
-- The reason nothing caught it: a separate defect left `auditor` matching no
-- visibility rule at all, so it could not SEE an application to move. The
-- guarantee was being enforced by a bug, and fixing the bug exposed the hole.
--
-- Rewritten in full from the compiled table rather than patched, so the seed and
-- `TRANSITIONS` cannot drift -- `transition-seed.spec` compares every field and
-- the ordinal of every row.
update lifecycle_transitions set ordinal = 0, actors = array['applicant'], requires_scope = 'applications:write', preconditions = array['identity-document-verified', 'required-documents-present'], notifies = 'application-submitted'
  where from_status = 'Draft' and to_status = 'Submitted';
update lifecycle_transitions set ordinal = 1, actors = array['applicant'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Draft' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 2, actors = array['staff'], requires_scope = 'staff:receive', preconditions = '{}', notifies = 'received-by-obo'
  where from_status = 'Submitted' and to_status = 'Received';
update lifecycle_transitions set ordinal = 3, actors = array['applicant', 'staff'], requires_scope = 'applications:write', preconditions = '{}', notifies = null
  where from_status = 'Submitted' and to_status = 'Cancelled';
update lifecycle_transitions set ordinal = 4, actors = array['staff'], requires_scope = 'staff:receive', preconditions = '{}', notifies = 'document-verification-started'
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
