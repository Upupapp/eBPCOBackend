-- What happens when a payment has to be undone.
--
-- Three different things, and the distinction is the whole point of this
-- migration. Collapsing them into one "cancelled" status would lose the fact
-- that decides what the LGU owes:
--
--   VOIDED    the record should never have existed. A clerical error -- entered
--             against the wrong application, or twice. Nothing was confirmed
--             and no money is in question.
--   REVERSED  it was confirmed as Paid and the money never actually arrived: a
--             bounced cheque, a transfer that failed after the officer had
--             already seen the proof. The LGU holds nothing and is owed the fee.
--   REFUNDED  the money DID arrive and is being returned -- a superseded
--             assessment reduced the fee, or the application was withdrawn. The
--             LGU held the money and no longer should.
--
-- "Reversed" and "Refunded" look alike in a list and mean opposite things about
-- who is out of pocket.
alter table payments drop constraint payments_status_check;

alter table payments add constraint payments_status_check check (status in (
  'Not Yet Available', 'Pending Verification', 'Paid', 'Overdue',
  'Voided', 'Reversed', 'Refunded'));

alter table payments
  add column exception_reason  text,
  add column exception_at      timestamptz,
  add column exception_by      uuid references accounts (id) on delete restrict;

-- An exception with nobody responsible for it, or with no reason an applicant
-- can be told, is money moving with no explanation attached. The status and the
-- three columns move together or not at all.
alter table payments add constraint exception_is_attributable check (
  (status not in ('Voided', 'Reversed', 'Refunded')
     and exception_reason is null and exception_at is null and exception_by is null)
  or (status in ('Voided', 'Reversed', 'Refunded')
     and exception_reason is not null and exception_at is not null and exception_by is not null)
);

-- `paid_requires_verification` was written when 'Paid' was the only settled
-- status. A reversed or refunded payment WAS verified and keeps its verifier
-- and its receipt number -- that history is the evidence the money once moved,
-- and dropping it would leave the reversal unexplainable.
alter table payments drop constraint paid_requires_verification;
alter table payments add constraint settled_requires_verification check (
  status not in ('Paid', 'Reversed', 'Refunded')
  or (verified_at is not null and official_receipt_number is not null)
);
