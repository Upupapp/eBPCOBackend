-- Staff identity for the LGU's editors.
--
-- The confirmation workflow in TAB 02 derives its entire value from the
-- identity attached to a confirmation. Without this, the provenance trail
-- records that 'someone' confirmed the Mayor's name, which is not an audit
-- trail — it is a rumour with a timestamp.
--
-- The role names here are the portal's own. The eBPCO Web Admin's staff roles
-- model permit-processing duties (receiving, assessing, releasing) and do not
-- describe editing a website; borrowing them would put a vocabulary about
-- transactions in charge of prose.
create type staff_role as enum (
  'viewer',                  -- may read pending content and the backlog; writes nothing
  'content-editor',          -- proposes changes, confirms none
  'content-approver',        -- confirms proposals, subject to the four-eyes rule
  'announcements-publisher', -- publishes and withdraws announcements
  'administrator'            -- manages accounts, and NOT content
);

create table staff_accounts (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (position('@' in email) > 1),
  display_name  text not null check (length(trim(display_name)) > 0),
  role          staff_role not null,

  -- scrypt$N$r$p$salt$digest, matching apps/ebpco-api's format so one reviewer
  -- reads both. Never a plaintext or a reversible encoding.
  password_hash text not null check (password_hash like 'scrypt$%'),

  disabled_at   timestamptz,
  -- Lockout after repeated failures. Stored on the account rather than derived
  -- from a log, so the check is one indexed read on the sign-in path.
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  locked_until  timestamptz,

  created_at    timestamptz not null default now()
);

-- OPAQUE SERVER-SIDE SESSIONS, not a signed token.
--
-- TAB 11 requires that sign-out actually revokes, and a sibling project in this
-- portfolio was bitten by a credential that stayed valid after sign-out. With a
-- signed token that guarantee depends on a denylist being consulted on every
-- request — one forgotten check and the credential lives on. Here the row IS
-- the session: deleting it ends it, and there is no code path that can forget.
create table staff_sessions (
  -- sha256 of the bearer token. The token itself is shown once, to its owner,
  -- and never stored: a database dump must not be a set of live credentials.
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  account_id   uuid not null references staff_accounts (id) on delete cascade,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz,
  constraint staff_session_expires_after_issue check (expires_at > issued_at)
);

create index staff_sessions_by_account on staff_sessions (account_id);

-- Every sign-in attempt, successful or not. TAB 11 requires repeated failures
-- be LOGGED as well as locked out, and this is also the record that shows an
-- attack on an account that does not exist.
create table sign_in_attempts (
  id           uuid primary key default gen_random_uuid(),
  -- The address as TYPED. Not a foreign key, deliberately: attempts against
  -- addresses with no account are the ones worth seeing.
  email        text not null,
  succeeded    boolean not null,
  -- Why it failed, for the operator. NEVER returned to the caller: the API
  -- says the same thing for a wrong password and an unknown address.
  reason       text,
  at           timestamptz not null default now()
);

create index sign_in_attempts_by_email on sign_in_attempts (email, at desc);
