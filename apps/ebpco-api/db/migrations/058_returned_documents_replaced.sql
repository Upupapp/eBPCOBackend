-- A returned application goes back to the office only once the applicant has
-- replaced what the office returned.
--
-- `Revision Required -> Under Evaluation` is the applicant's move alone, and
-- until now its only precondition was `all-instructions-resolved` -- open
-- items on a Letter of Instruction. Nothing in the service issues letters:
-- officers return an application by marking documents Revision Required (or
-- Rejected) and moving the status. So the one rule guarding this move could
-- never refuse it, and the new `POST /applications/:id/resubmit` route would
-- have let an applicant send an application straight back with the returned
-- document untouched.
--
-- `returned-documents-replaced` is satisfied when every document on the
-- application whose review is Revision Required or Rejected has a newer
-- upload superseding it (documents.supersedes_document_id). Computed in
-- LifecycleService's snapshot; evaluated by the lifecycle engine.
--
-- Appended rather than overwritten, and only if absent, so a workflow an
-- administrator has already edited keeps its other preconditions.
update lifecycle_transitions
   set preconditions = array_append(preconditions, 'returned-documents-replaced')
 where from_status = 'Revision Required' and to_status = 'Under Evaluation'
   and not ('returned-documents-replaced' = any(preconditions));
