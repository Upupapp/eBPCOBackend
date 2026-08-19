-- Notifications, push devices, and the audit trail.

create table notification_types (
  type      text primary key,
  category  text not null check (category in
              ('Application progress', 'Action required', 'Payments', 'Inspections', 'Releases')),
  requires_action boolean not null default false
);

-- The closed catalog. Free text is not permitted: the LGU must be able to
-- account for exactly what it told an applicant and when, and "whatever the
-- code wrote that day" is not an account.
insert into notification_types (type, category, requires_action) values
  ('application.submitted',                       'Application progress', false),
  ('application.received',                        'Application progress', false),
  ('application.document-verification-started',   'Application progress', false),
  ('application.document-rejected',               'Action required',      true),
  ('application.evaluation-started',              'Application progress', false),
  ('application.evaluation-passed',               'Application progress', false),
  ('application.revision-required',               'Action required',      true),
  ('application.instruction-issued',              'Action required',      true),
  ('application.instruction-resolved',            'Application progress', false),
  ('application.assessed',                        'Payments',             true),
  ('application.payment-submitted',               'Payments',             false),
  ('application.payment-under-verification',      'Payments',             false),
  ('application.payment-verified',                'Payments',             false),
  ('application.payment-rejected',                'Action required',      true),
  ('application.for-approval',                    'Application progress', false),
  ('application.approved',                        'Application progress', false),
  ('application.rejected',                        'Application progress', false),
  ('application.permit-generated',                'Application progress', false),
  ('application.ready-for-release',               'Releases',             true),
  ('application.released',                        'Releases',             false),
  ('application.completed',                       'Application progress', false),
  ('application.expired',                         'Application progress', false),
  ('application.cancelled',                       'Application progress', false),
  ('inspection.scheduled',                        'Inspections',          true);

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
