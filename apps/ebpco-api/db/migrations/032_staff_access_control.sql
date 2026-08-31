-- Admin access control: which FORMS a staff account may work on, and at what
-- LEVEL — plus the request queue that is the only way to become staff.
--
-- ── The rule this exists to make true ───────────────────────────────────
--
-- Self-service sign-up must NEVER produce a staff account. `/auth/register`
-- mints an applicant with no roles and that does not change; a person wanting
-- staff access raises a REQUEST, and only a super admin turns a request into an
-- account. A request that could become an account by itself is a sign-up form
-- with extra steps.
--
-- ── Why the allow-list is not a scope ───────────────────────────────────
--
-- Scopes stay global and coarse, as `account.ts` already argues: a scope says
-- what KIND of operation a caller may attempt, and whether they may attempt it
-- on THIS application is a domain question. "Which permit types may this
-- officer work on" is exactly that domain question, so it lives in a table
-- keyed by account and permit type — not as seventeen new scopes that would
-- have to be minted into every token.
--
-- ── Additive only, and why there is no down ─────────────────────────────
--
-- `scripts/migrate.ts` states the position: no down-migrations, because a
-- down-migration is a second and far less tested path that runs at the worst
-- possible moment. This migration is therefore strictly ADDITIVE — new tables,
-- one new nullable column, and a backfill that PRESERVES existing behaviour. It
-- drops nothing and rewrites nothing, so reversing it is lossless and is
-- written out in db/migrations/ROLLBACK-032.sql for an operator who needs it.

-- ── Levels ──────────────────────────────────────────────────────────────
--
-- Two, and deliberately only two. 'view' is sight; 'view-edit' is authority —
-- responding to applicants and deciding applications. The scopes each level
-- yields are DERIVED in code from `grantsAuthority()`, so this column names the
-- level and never duplicates the scope list.
create table staff_access (
  account_id  uuid primary key references accounts (id) on delete cascade,
  level       text not null check (level in ('view', 'view-edit')),
  assigned_by uuid not null references accounts (id),
  assigned_at timestamptz not null default now()
);

-- ── The forms allow-list ────────────────────────────────────────────────
--
-- Internal permit-type KEYS, never the published names. There are 17 keys and
-- 19 published names and they are not a mismatch to be repaired — see
-- src/modules/permits/domain/published-vocabulary.ts. Storing a published name
-- here would put a display label in an authorisation decision.
create table staff_permit_access (
  account_id  uuid not null references accounts (id) on delete cascade,
  permit_type text not null references permit_types (permit_type) on delete restrict,
  granted_by  uuid not null references accounts (id),
  granted_at  timestamptz not null default now(),
  primary key (account_id, permit_type)
);

create index staff_permit_access_by_type on staff_permit_access (permit_type);

-- Retirement is a FLAG, not a delete.
--
-- A permit type the LGU stops issuing must not vanish: applications reference
-- it, and an allow-list entry naming it has to stay readable to explain why an
-- officer once had access. Consistent with the archive-only rule that governs
-- every other record here.
alter table permit_types add column retired_at timestamptz;

comment on column permit_types.retired_at is
  'Set when the LGU stops issuing this permit type. Never deleted: applications '
  'reference it and access grants naming it must stay explicable.';

-- ── Access requests ─────────────────────────────────────────────────────
create table access_requests (
  id              uuid primary key default gen_random_uuid(),

  full_name       text not null check (length(trim(full_name)) > 0),
  -- Stored as typed AND normalised. The normalised form is what the duplicate
  -- check reads, for the same account-takeover reason `accounts` normalises.
  email           text not null,
  email_normalised text not null,
  mobile          text not null check (length(trim(mobile)) > 0),
  office_position text not null check (length(trim(office_position)) > 0),

  requested_level text not null check (requested_level in ('view', 'view-edit')),
  justification   text not null check (length(trim(justification)) >= 20),

  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  raised_at       timestamptz not null default now(),

  decided_at      timestamptz,
  decided_by      uuid references accounts (id),
  -- A rejection must say why. An approval need not: the assignment it creates
  -- IS its explanation, and is itself audited.
  decision_reason text,

  -- The account an approval created, so a request can be traced to its outcome.
  created_account_id uuid references accounts (id),

  constraint access_request_decision_is_attributable
    check ((status = 'pending' and decided_at is null and decided_by is null)
        or (status <> 'pending' and decided_at is not null and decided_by is not null)),
  constraint access_request_rejection_states_a_reason
    check (status <> 'rejected' or length(trim(coalesce(decision_reason, ''))) >= 3)
);

-- One OPEN request per address. A partial index, so a person refused once may
-- ask again, and an approved account does not block a later request for a
-- different level.
create unique index access_requests_one_open_per_email
  on access_requests (email_normalised) where status = 'pending';

create index access_requests_pending on access_requests (raised_at, id)
  where status = 'pending';

-- The permit types a request ASKS for.
--
-- No foreign key, on purpose. A request may name a type that is later retired,
-- or one the requester mistyped; both must be reviewable rather than rejected
-- at insert by an unauthenticated caller probing which types exist.
create table access_request_permit_types (
  request_id  uuid not null references access_requests (id) on delete cascade,
  permit_type text not null,
  primary key (request_id, permit_type)
);

-- ── Rate limiting the one unauthenticated write ─────────────────────────
--
-- Per address AND per IP: per-address alone is defeated by one attacker
-- enumerating addresses, and per-IP alone by one address hammered from a
-- botnet. Recorded rather than held in memory, because a limit that resets on
-- deploy is a limit an attacker waits out.
create table access_request_attempts (
  id         bigserial primary key,
  -- Normalised address, or null when the body did not parse far enough to have
  -- one. The row is still written: an attacker sending garbage is information.
  email_normalised text,
  ip_address text not null,
  at         timestamptz not null default now()
);

create index access_request_attempts_by_email on access_request_attempts (email_normalised, at desc);
create index access_request_attempts_by_ip on access_request_attempts (ip_address, at desc);

-- ── Backfill: every existing staff account ends up EXPLICITLY assigned ──
--
-- An empty allow-list fails closed, so a deploy that added these tables without
-- this backfill would lock every serving officer out of every application. The
-- backfill preserves exactly today's behaviour and states it in data:
--
--   * level follows the role — 'view-edit' where the role already grants
--     authority (any :write or staff:* scope), 'view' where it does not. That
--     is `grantsAuthority()` expressed in SQL, and the code derives the same
--     answer from the function so the two cannot disagree unnoticed.
--   * every permit type, because that is what every officer has today.
--
-- `assigned_by` is the account's own id. There was no super admin to attribute
-- this to; recording the truth — that the migration assigned it — is better
-- than naming an administrator who did not.
insert into staff_access (account_id, level, assigned_by)
select a.id,
       case when exists (
         select 1 from account_roles r
          where r.account_id = a.id
            and r.role in ('records-officer', 'receiving-officer', 'evaluator', 'assessor',
                           'cashier', 'building-official', 'releasing-officer',
                           'administrator', 'super-admin')
       ) then 'view-edit' else 'view' end,
       a.id
  from accounts a
 where a.kind = 'staff'
on conflict (account_id) do nothing;

insert into staff_permit_access (account_id, permit_type, granted_by)
select a.id, p.permit_type, a.id
  from accounts a cross join permit_types p
 where a.kind = 'staff'
on conflict (account_id, permit_type) do nothing;

comment on table staff_access is
  'Per-account access level. The scope bundle each level yields is derived in '
  'code from grantsAuthority(), never duplicated here.';
comment on table staff_permit_access is
  'Per-account permit-type allow-list, in INTERNAL keys. Empty means no access: '
  'this fails closed by construction.';

-- ── RA 10173 records of processing ──────────────────────────────────────
--
-- Every personal-data column carries a COMMENT beginning 'pii:', read back out
-- of the PostgreSQL catalog by src/persistence/personal-data-inventory.ts. The
-- register in personal-data.ts and these comments are cross-checked, so a
-- column classified in one and not the other fails the build — which is how a
-- new table stops being "the personal data we thought of".
--
-- The access-request columns are the interesting case: they describe someone
-- who may NEVER become an account. A refused request holds a name, a mobile
-- number and a written justification about a person the LGU has no ongoing
-- relationship with, so the basis is administering access and the retention is
-- operational — not an account lifetime there is no account for.
comment on column access_requests.full_name is
  'pii:identity:name — lawful basis: administering staff access to a public service';
comment on column access_requests.email is
  'pii:contact:email — lawful basis: administering staff access to a public service';
comment on column access_requests.email_normalised is
  'pii:contact:email — derived, same basis as access_requests.email';
comment on column access_requests.mobile is
  'pii:contact:mobile — lawful basis: administering staff access to a public service';
comment on column access_requests.office_position is
  'pii:identity:employment — identifies a person when combined with a small office, '
  'which every office in this municipality is';
comment on column access_requests.justification is
  'pii:content:free-text — written by the requester; may contain anything, including '
  'personal data about a third party';
comment on column access_requests.decision_reason is
  'pii:content:free-text — written by a super admin ABOUT the requester';
comment on column access_requests.decided_by is
  'pii:identity:account-reference — which staff member decided; accountability under '
  'NPC Circular 16-01';
comment on column access_requests.created_account_id is
  'pii:identity:account-reference — the account an approval created';

comment on column access_request_permit_types.request_id is
  'pii:identity:request-reference — ties requested permit types to one person';

comment on column access_request_attempts.email_normalised is
  'pii:contact:email — lawful basis: refusing abuse of the one unauthenticated write';
comment on column access_request_attempts.ip_address is
  'pii:network:ip — an IP address is personal data under RA 10173; held only to refuse '
  'abuse, and purged rather than kept against a person';

comment on column staff_access.account_id is
  'pii:identity:account-reference — whose access level this is';
comment on column staff_access.assigned_by is
  'pii:identity:account-reference — who assigned it; accountability under NPC Circular 16-01';
comment on column staff_permit_access.account_id is
  'pii:identity:account-reference — whose allow-list this is';
comment on column staff_permit_access.granted_by is
  'pii:identity:account-reference — who granted it; accountability under NPC Circular 16-01';
