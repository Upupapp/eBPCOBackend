-- Identity: the accounts this service authenticates, and the sessions it issues.
--
-- Personal-data columns are tagged with a COMMENT beginning 'pii:'. That is not
-- documentation: TAB 20 generates the RA 10173 records of processing by reading
-- these comments back out of the catalog, so the register and the schema cannot
-- drift. A column holding personal data with no tag is a finding.

create table accounts (
  id                  uuid        primary key default gen_random_uuid(),

  -- 'applicant' or 'staff'. A check constraint rather than an enum type:
  -- adding a value to a PostgreSQL enum cannot be done inside a transaction
  -- with other DDL in some versions, and this set is stable enough not to need
  -- the extra type.
  kind                text        not null check (kind in ('applicant', 'staff')),

  email               text        not null,
  -- Normalised (trimmed, lower-cased) by the application. Unique on the
  -- normalised form, so 'Maria@Example.PH' and 'maria@example.ph' cannot become
  -- two accounts that every applicant would consider the same -- which is an
  -- account-takeover vector, not a tidiness question.
  email_normalised    text        not null unique,

  -- The scrypt verifier, self-describing. Never reversible, never returned.
  password_hash       text        not null,

  mobile_number       text,
  email_verified_at   timestamptz,
  mobile_verified_at  timestamptz,

  -- Encrypted at the application layer before it reaches this column: a TOTP
  -- secret in plaintext lets anyone with a database dump mint valid codes
  -- forever, which defeats the second factor entirely.
  totp_secret_encrypted bytea,

  disabled_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid
);

comment on column accounts.email              is 'pii:contact:email — lawful basis: performance of a public task (RA 11032 service delivery)';
comment on column accounts.email_normalised   is 'pii:contact:email — derived, same basis as accounts.email';
comment on column accounts.mobile_number      is 'pii:contact:mobile — used for the second verification channel (ADR 0004)';
comment on column accounts.password_hash      is 'credential:verifier — not personal data, but never exportable and never logged';
comment on column accounts.totp_secret_encrypted is 'credential:mfa-seed — encrypted at the application layer';

create index accounts_kind_idx on accounts (kind) where disabled_at is null;

-- Staff roles. A join table rather than an array column, so a role can be
-- granted and revoked with an audited row rather than by rewriting an array --
-- and so "who holds this role" is an index lookup rather than a scan.
create table account_roles (
  account_id  uuid        not null references accounts (id) on delete cascade,
  role        text        not null check (role in (
                'receiving-officer', 'records-officer', 'evaluator', 'assessor',
                'cashier', 'building-official', 'releasing-officer', 'administrator')),
  granted_at  timestamptz not null default now(),
  granted_by  uuid        references accounts (id),
  primary key (account_id, role)
);

-- An applicant may never hold a staff role. Enforced here rather than in the
-- service, because a privilege-escalation bug that has to defeat a database
-- constraint is a much harder bug to write than one that has to defeat an `if`.
create or replace function reject_role_on_applicant() returns trigger as $$
begin
  if (select kind from accounts where id = new.account_id) <> 'staff' then
    raise exception 'account % is not staff and may not hold role %', new.account_id, new.role
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger account_roles_staff_only
  before insert or update on account_roles
  for each row execute function reject_role_on_applicant();

-- Refresh tokens. The secret itself is never stored -- only its SHA-256 digest.
create table refresh_tokens (
  id             uuid        primary key,
  family_id      uuid        not null,
  account_id     uuid        not null references accounts (id) on delete cascade,
  secret_digest  text        not null,
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  -- Set when exchanged. A second exchange of the same row is a replay, and the
  -- application revokes the whole family on seeing it.
  consumed_at    timestamptz,
  revoked_at     timestamptz,

  constraint refresh_token_expires_after_issue check (expires_at > issued_at)
);

comment on column refresh_tokens.secret_digest is 'credential:session — digest only; the secret exists solely in the client';

create index refresh_tokens_family_idx  on refresh_tokens (family_id);
create index refresh_tokens_account_idx on refresh_tokens (account_id) where revoked_at is null;

create table password_reset_tickets (
  token_digest  text        primary key,
  account_id    uuid        not null references accounts (id) on delete cascade,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,

  constraint reset_ticket_expires_after_issue check (expires_at > issued_at)
);

comment on column password_reset_tickets.token_digest is 'credential:recovery — digest only, single use';
