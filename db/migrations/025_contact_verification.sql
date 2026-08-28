-- Whether the LGU can rely on the details it sends every notice to.
--
-- The account row has carried an email and a mobile number since the beginning
-- and `email_verified_at` / `mobile_verified_at` beside them, but nothing ever
-- set either: there was no way for an applicant to prove a channel, so every
-- notice went to an address nobody had confirmed. The admin has modelled four
-- statuses and four methods all along; this is the table that can hold them.
--
-- TWO CHANNELS, SEPARATELY. An account whose email is confirmed and whose
-- mobile number is not is a real and common state — the office telephones about
-- an ocular inspection and emails everything else — and one status for the pair
-- could not express it.
create table contact_verifications (
  account_id     uuid not null references accounts (id) on delete cascade,
  channel        text not null check (channel in ('email', 'mobile')),

  -- The admin's own vocabulary, on the wire exactly as written here.
  -- 'Verification Failed' is deliberately distinct from 'Unverified': one means
  -- nobody tried, the other means it was tried and did not work.
  status         text not null default 'Unverified'
                   check (status in ('Unverified', 'Pending Verification', 'Verified',
                                     'Verification Failed')),

  -- How it was verified, once it has been. Null while it has not — including
  -- while a request is pending, because the method that eventually succeeds may
  -- not be the one the applicant started.
  method         text check (method in ('Email Verification Link', 'Mobile OTP',
                                        'Manual Administrator Confirmation',
                                        'Verified-Document Matching')),
  verified_at    timestamptz,

  -- When they last asked for a link or a code. What separates "not yet
  -- attempted" from "attempted and failed" before a status has moved.
  last_requested_at timestamptz,

  primary key (account_id, channel),
  constraint verified_says_how check (
    (status <> 'Verified' and verified_at is null)
    or (status = 'Verified' and method is not null and verified_at is not null)
  )
);

-- The outstanding challenge for a channel.
--
-- A DIGEST, never the code. The same reasoning as the password-reset tickets:
-- anyone who can read this table could otherwise verify any channel in it, and
-- a database backup would carry live credentials. The code exists in one place
-- for one moment — on its way to the applicant.
create table contact_verification_challenges (
  id             uuid        primary key default gen_random_uuid(),
  account_id     uuid        not null references accounts (id) on delete cascade,
  channel        text        not null check (channel in ('email', 'mobile')),
  code_digest    text        not null,

  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,

  -- Six digits is a million guesses, which is nothing to a machine. The limit
  -- is what makes the code a secret rather than a formality.
  attempts       integer     not null default 0 check (attempts >= 0),

  constraint challenge_expires_after_issue check (expires_at > issued_at)
);

-- One live challenge per channel. Two outstanding codes means the applicant
-- cannot tell which one to type, and an attacker gets two guesses per request.
create unique index one_live_challenge_per_channel
  on contact_verification_challenges (account_id, channel)
  where consumed_at is null;
