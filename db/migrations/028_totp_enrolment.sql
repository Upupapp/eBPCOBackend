-- Enrolling a second factor, and not being locked out by it.
--
-- `accounts.totp_secret_encrypted` has existed since the first migration and
-- nothing has ever written it, while `requiresMfa` has demanded a code from
-- assessors, cashiers, building officials, releasing officers and
-- administrators all along. `verifyTotp` fails closed with no secret, so those
-- roles could not sign in AT ALL — a property nobody noticed until a client was
-- pointed at a running server, because every test mints its tokens directly.
--
-- A SEPARATE TABLE FOR THE PENDING SECRET. Writing straight to the account
-- column would activate the factor the moment it was generated, so an officer
-- whose authenticator app failed to scan would be locked out by the act of
-- trying to enrol. The secret moves to the account only once a code proves the
-- app holds it.
create table totp_enrolments (
  account_id       uuid        primary key references accounts (id) on delete cascade,
  secret_encrypted text        not null,
  started_at       timestamptz not null default now(),
  -- An abandoned enrolment is a secret sitting in a table for no reason. The
  -- operational purge sweeps them.
  expires_at       timestamptz not null,

  constraint enrolment_expires_after_it_starts check (expires_at > started_at)
);

-- Which step was last spent, so a code cannot be used twice inside its window.
-- An attacker who watches a code being typed has thirty seconds to use it
-- again, and without this they would succeed.
alter table accounts add column totp_last_step bigint;
