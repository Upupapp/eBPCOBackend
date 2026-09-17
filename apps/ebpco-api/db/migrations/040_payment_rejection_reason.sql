-- A rejected payment's reason currently lives only in the audit trail
-- (`payment.rejected`'s `afterState`), a staff-only stream — the payment row
-- itself just resets to 'Not Yet Available', identical in shape to a payment
-- nobody has ever submitted. That is enough for the applicant to know to try
-- again, but not enough to tell them WHY, or for the applicant's own payment
-- history to show a rejection ever happened.
--
-- Not `exception_reason`/`exception_at` (migration 020): those are reserved
-- for Voided/Reversed/Refunded by `exception_is_attributable`, which is a
-- deliberate three-way distinction about who is out of pocket. A rejection is
-- a fourth, different thing — nothing was ever confirmed, so no money
-- question exists — and reusing those columns would blur that distinction
-- migration 020 was written specifically to keep clear.
--
-- Each submission is its own row (`PaymentService.submitProof` always
-- inserts, never updates), so a rejected row simply stays in the table as
-- its own permanent record once these columns are set — a citizen's payment
-- history naturally shows it alongside whatever was submitted after.
alter table payments
  add column rejection_reason text,
  add column rejected_at      timestamptz;
