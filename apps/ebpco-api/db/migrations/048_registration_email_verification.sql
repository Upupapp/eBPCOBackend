-- Verifying an email BEFORE the account it will belong to exists.
--
-- contact_verification_challenges (migration 025) proves a channel for an
-- ACCOUNT THAT ALREADY EXISTS -- it needs `account_id`, and there is none
-- yet at the point in the registration wizard this is for: the citizen has
-- typed an email and nothing else, on Step 2 of 3, before Continue has even
-- been pressed once. This is the pre-account equivalent, keyed by the email
-- itself rather than an account.
--
-- `confirmed_at` and `consumed_at` are deliberately two different columns.
-- Confirming a code proves the applicant reached that inbox once; it must
-- not become a standing credential good for registering an unlimited number
-- of accounts against that address, so `POST /auth/register` consumes the
-- row the one time it actually uses it. A confirmed-but-unconsumed row is
-- exactly the proof `register()` looks for; a consumed one is spent.
create table registration_email_challenges (
  id             uuid        primary key default gen_random_uuid(),
  -- Normalised (lower-cased, trimmed) the same way accounts.email_normalised
  -- is, so a request for "Maria@Example.PH" and a confirm for
  -- "maria@example.ph" are the same row.
  email          text        not null,
  code_digest    text        not null,

  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  -- Set once the right code is entered; null until then and forever if it
  -- never is. Distinct from consumed_at -- see the module comment above.
  confirmed_at   timestamptz,
  -- Set once register() actually spends this confirmation. A row can be
  -- confirmed without being consumed (the applicant closed the tab before
  -- finishing Step 3); it cannot be consumed without being confirmed.
  consumed_at    timestamptz,

  attempts       integer     not null default 0 check (attempts >= 0),

  constraint registration_challenge_expires_after_issue check (expires_at > issued_at),
  constraint registration_challenge_consumed_implies_confirmed check (
    consumed_at is null or confirmed_at is not null
  )
);

-- One live (unconfirmed, unconsumed) challenge per email, same reasoning as
-- migration 025's own one_live_challenge_per_channel: two outstanding codes
-- for one address means the applicant cannot tell which to type, and an
-- attacker gets two guesses per request.
create unique index one_live_registration_challenge_per_email
  on registration_email_challenges (email)
  where confirmed_at is null and consumed_at is null;

create index registration_email_challenges_email_idx
  on registration_email_challenges (email);
