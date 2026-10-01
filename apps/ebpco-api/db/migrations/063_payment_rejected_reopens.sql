-- A rejected payment puts the application back to Assessed (2026-10-01).
--
-- `POST /staff/payments/:id/reject` reset the payment row and nothing else,
-- so the application stayed at Payment Submitted: the applicant's own page
-- said "awaiting verification" beside a Payments page asking for the money
-- again, the cashier's queue showed nothing left to check, and the next
-- payment could not move the application (Payment Submitted -> Payment
-- Submitted is no move). Assessed is where it stood before the payment was
-- sent, with its Order of Payment still in force, and Assessed -> Payment
-- Submitted is the applicant's own move when they pay again.
--
-- The cashier's own scope, `staff:verify-payment`, since the move is part of
-- rejecting a payment and made by that same request; `actors = ['staff']`
-- only. No notification: "payment rejected" has no type in the client
-- catalog yet (lifecycle.ts's own note on the gap); the rejection reason is
-- on the applicant's payment history, and the move is on their timeline.
insert into lifecycle_transitions
  (from_status, to_status, ordinal, actors, requires_scope, preconditions, notifies)
values
  ('Payment Submitted', 'Assessed', 32, array['staff'], 'staff:verify-payment', '{}', null);
