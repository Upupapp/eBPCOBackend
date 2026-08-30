-- The outbox needs to know what it has already planned.
--
-- Set only once a delivery plan exists for a row. A crash before that leaves
-- the row pending and it is planned again — at-least-once rather than
-- at-most-once, which for a notice is the right side to err on: a duplicate
-- notification is an annoyance, a missing one is a missed deadline.
alter table notifications add column dispatched_at timestamptz;

create index notifications_pending_idx on notifications (created_at) where dispatched_at is null;

-- What actually went out, per channel, so an undelivered notice with a
-- statutory consequence is visible rather than assumed.
create table notification_deliveries (
  id               uuid        primary key default gen_random_uuid(),
  notification_id  uuid        not null references notifications (id) on delete cascade,
  channel          text        not null check (channel in ('push', 'email', 'sms')),
  status           text        not null default 'queued'
                     check (status in ('queued', 'sent', 'failed', 'deferred')),
  deferred_until   timestamptz,
  attempted_at     timestamptz,
  attempts         integer     not null default 0 check (attempts >= 0),
  failure_detail   text,

  unique (notification_id, channel)
);

create index notification_deliveries_due_idx on notification_deliveries (deferred_until)
  where status = 'deferred';
