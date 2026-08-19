-- Erasure that keeps its promise, enforced by the database rather than by a
-- service that says it did.
--
-- Two laws apply and they do not agree. RA 10173 §16(e) gives a data subject
-- the right to erasure. PD 1096 and the LGU records schedule require a building
-- permit record to be kept -- a permit is evidence that a structure was
-- authorised, and it outlives the applicant's relationship with the LGU by
-- decades. Both are true.
--
-- The account row is NOT deleted, and that is a decision rather than a
-- shortcut. Deleting it would either break the audit chain or break the permit
-- record:
--
--   The chain hashes `actor_account_id` into every entry. Nulling it on delete
--   invalidates every entry after, and a chain that fails verification cannot
--   be told apart from a forged one -- so the erasure would destroy the very
--   evidence that the erasure was carried out.
--
--   The permit record attributes each act to an account: who uploaded a
--   document, who submitted a payment, who evaluated. Dropping those references
--   leaves a record that cannot say who did what, which is not a record.
--
-- So the row survives as an opaque key holding no personal data, and the
-- constraint below is what makes that claim checkable. A service can promise it
-- cleared the contact details; a CHECK constraint means an account marked
-- erased CANNOT still hold them, whatever wrote to it.

alter table accounts
  add column erased_at timestamptz;

comment on column accounts.erased_at is
  'Set when the data subject exercised RA 10173 s.16(e). The row survives as an opaque key '
  'so the audit chain stays verifiable and the permit record keeps its attributions; '
  'erased_account_holds_no_personal_data is what guarantees it holds nothing else.';

-- The guarantee, in the schema.
--
-- `.invalid` is reserved by RFC 2606 precisely so a placeholder address cannot
-- collide with a real one or be delivered to. The email column stays NOT NULL
-- UNIQUE, so it needs a value; this one is obviously not a person's.
alter table accounts
  add constraint erased_account_holds_no_personal_data check (
    erased_at is null
    or (
      email like 'erased-%@erased.invalid'
      and mobile_number is null
      and totp_secret_encrypted is null
      -- Not a usable verifier. An erased account that could still be signed
      -- into is not erased.
      and password_hash = 'erased'
      and disabled_at is not null
    )
  );

-- An erased account has no devices, sessions or notifications: those are
-- deleted outright, since nothing statutory requires keeping a way to reach or
-- authenticate someone who has left. They cascade from accounts already
-- (migration 001), so no constraint is needed here -- this comment records that
-- the omission is deliberate rather than an oversight.
