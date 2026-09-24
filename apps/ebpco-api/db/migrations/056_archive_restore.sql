-- Archive: "Unarchive", answered as a real lifecycle move rather than a
-- second, informal way to write `lifecycle_status`.
--
-- The Archive screen (archive.ts) has been deliberately read-only since its
-- own introduction: "Restoring an application is a lifecycle transition and
-- belongs to the workflow that governs transitions, not to a list that
-- exists to show what happened." Until now there was no such transition to
-- belong to -- Cancelled, Rejected and Expired each had zero onward moves
-- (002_reference.sql's own seed, unchanged since), so there was nothing the
-- Applications detail page's own "Action" menu could have offered even if
-- asked to. This migration is that missing other half.
--
-- Restored to Submitted specifically, not to wherever the application
-- happened to leave the active queue FROM: Cancelled and Rejected are each
-- reachable from a dozen different statuses (decision E-4's own cancellation
-- points; the Document Verification / Under Evaluation / For Approval
-- rejection trio), so there is no single "the" prior status to reopen into.
-- Guessing one would be a silent policy decision this migration is not in a
-- position to make on an LGU's behalf. Submitted is the one place every
-- application has genuinely already been, and restarting the queue from
-- there costs an officer one "Mark Received" click, not a re-filed
-- application with a new reference number.
--
-- `staff:approve` rather than a receiving-desk scope: reopening a closed
-- record is the same order of decision as Approve/Reject/Revision Required
-- (migration 029's own seed), made by the same tier of officer, not a
-- routine intake action. `actors = ['staff']` only -- an applicant cannot
-- reopen their own cancelled or rejected filing by asking for a transition
-- directly; that is what re-filing exists for.
insert into lifecycle_transitions
  (from_status, to_status, ordinal, actors, requires_scope, preconditions, notifies)
values
  ('Cancelled', 'Submitted', 29, array['staff'], 'staff:approve', '{}', null),
  ('Rejected', 'Submitted', 30, array['staff'], 'staff:approve', '{}', null),
  ('Expired', 'Submitted', 31, array['staff'], 'staff:approve', '{}', null);
