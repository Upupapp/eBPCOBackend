-- Notifications, push devices, and the audit trail.

create table notification_types (
  type            text primary key,
  category        text not null check (category in
                    ('applicationUpdates', 'payments', 'permitStatus',
                     'documentReminders', 'appointments', 'account')),
  requires_action boolean not null default false,
  -- False for the two the client derives locally and the server never sends:
  -- a draft is local until it is filed, and a credential expiry is computed
  -- from records the applicant keeps on the device.
  server_generated boolean not null default true
);

-- The closed catalog, and it is the MOBILE CLIENT's, adopted wholesale.
--
-- The wire name is the kebab-case of the client's own enum constant, so the
-- mapping is mechanical and total. The categories are the client's six, which
-- are already the mute buckets in its Settings screen.
--
-- An earlier version of this migration seeded a parallel vocabulary invented
-- here, which is exactly the drift TAB 01 exists to prevent. See
-- docs/decisions/0012-notification-catalog-reconciliation.md.
insert into notification_types (type, category, requires_action, server_generated) values
  ('application-submitted', 'applicationUpdates', false, true),
  ('received-by-obo', 'applicationUpdates', false, true),
  ('document-verification-started', 'documentReminders', false, true),
  ('letter-of-instruction-issued', 'documentReminders', true, true),
  ('evaluation-stage-passed', 'applicationUpdates', false, true),
  ('revision-required', 'documentReminders', true, true),
  ('fsec-cleared', 'applicationUpdates', false, true),
  ('order-of-payment-issued', 'payments', true, true),
  ('payment-received', 'payments', false, true),
  ('payment-verified', 'payments', false, true),
  ('payment-overdue', 'payments', true, true),
  ('approved', 'permitStatus', false, true),
  ('permit-generated', 'permitStatus', false, true),
  ('ready-for-release', 'permitStatus', true, true),
  ('released', 'permitStatus', false, true),
  ('rejected', 'permitStatus', true, true),
  ('inspection-scheduled', 'appointments', true, true),
  ('appointment-reminder', 'appointments', false, true),
  ('pledge-approaching', 'applicationUpdates', false, true),
  ('pledge-lapsed', 'applicationUpdates', true, true),
  ('permit-commencement-warning', 'permitStatus', true, true),
  ('professional-credential-expiring', 'documentReminders', false, false),
  ('draft-idle', 'documentReminders', false, false),
  ('occupancy-now-possible', 'permitStatus', false, true),
  ('account-update', 'account', false, true);

create table notifications (
  id              uuid        primary key default gen_random_uuid(),
  account_id      uuid        not null references accounts (id) on delete cascade,
  type            text        not null references notification_types (type),
  application_id  uuid        references applications (id) on delete restrict,

  title           text        not null,
  body            text        not null,
  deep_link       text,

  created_at      timestamptz not null default now(),
  -- Two different facts, and the distinction is load-bearing: opening a
  -- notification does not discharge the action it describes. The tab badge
  -- counts unresolved actions, not unread items.
  read_at         timestamptz,
  resolved_at     timestamptz
);

create index notifications_account_idx    on notifications (account_id, created_at desc);
create index notifications_unresolved_idx on notifications (account_id) where resolved_at is null;

create table notification_preferences (
  account_id         uuid        primary key references accounts (id) on delete cascade,
  -- Muting suppresses the PUSH only. The feed entry is still recorded, because
  -- the LGU must be able to show it told the applicant.
  muted_categories   text[]      not null default '{}',
  quiet_hours_enabled boolean    not null default true,
  quiet_hours_start  time        not null default '21:00',
  quiet_hours_end    time        not null default '07:00',
  updated_at         timestamptz not null default now()
);

create table devices (
  id                  uuid        primary key default gen_random_uuid(),
  account_id          uuid        not null references accounts (id) on delete cascade,
  platform            text        not null check (platform in ('android', 'ios')),
  -- A credential for reaching the device. Stored as a digest for lookup and
  -- encrypted for use; never returned by any endpoint.
  --
  -- "Encrypted" was aspirational until 2026-08-30: the column held the raw
  -- token, because no key had been chosen for it. It is AES-256-GCM under
  -- PUSH_TOKEN_ENCRYPTION_KEY now. Rows written before that date hold plaintext
  -- and will fail to open -- which is the correct outcome, since a token that
  -- old is likely stale anyway and the device re-registers on next launch.
  push_token_digest   text        not null,
  push_token_encrypted bytea      not null,
  app_version         text,
  locale              text,
  registered_at       timestamptz not null default now(),
  last_seen_at        timestamptz,
  unique (account_id, push_token_digest)
);

comment on column devices.push_token_encrypted is 'credential:push — reaching the device; never exported';

-- ── Audit ────────────────────────────────────────────────────────────────
--
-- Append-only and tamper-evident. NPC Circular 16-01 expects a government
-- agency to account for who VIEWED personal data, not only who changed it, so
-- reads are auditable here too.
create table audit_events (
  id              bigserial   primary key,
  occurred_at     timestamptz not null default now(),

  actor_account_id uuid       references accounts (id) on delete restrict,
  actor_role      text,
  action          text        not null,
  subject_type    text        not null,
  subject_id      text,
  outcome         text        not null check (outcome in ('allowed', 'denied', 'failed')),

  correlation_id  text,
  source_address  inet,
  before_state    jsonb,
  after_state     jsonb,

  -- Hash chain: each row commits to the previous one, so removing or editing a
  -- row breaks every row after it. Not a substitute for write-once storage, but
  -- it makes silent tampering detectable with a single pass.
  previous_hash   text,
  entry_hash      text        not null
);

comment on column audit_events.source_address is 'pii:contact:ip-address — where the action came from; an IP address identifies a person and is retained solely for accountability under NPC Circular 16-01';
comment on column audit_events.before_state   is 'pii:mixed:snapshot — may contain any personal data from the row it describes; retained on the audit schedule, never used for another purpose';
comment on column audit_events.after_state    is 'pii:mixed:snapshot — may contain any personal data from the row it describes; retained on the audit schedule, never used for another purpose';

create index audit_events_subject_idx on audit_events (subject_type, subject_id, occurred_at);
create index audit_events_actor_idx   on audit_events (actor_account_id, occurred_at);

-- No application credential may rewrite history, including an administrative
-- one. Enforced in the database because an audit trail the application can
-- edit is an audit trail that proves nothing about the application.
create or replace function reject_audit_mutation() returns trigger as $$
begin
  raise exception 'the audit trail is append-only'
    using errcode = 'insufficient_privilege';
end;
$$ language plpgsql;

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function reject_audit_mutation();
