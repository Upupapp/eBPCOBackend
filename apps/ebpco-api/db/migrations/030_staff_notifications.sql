-- TAB 14 — staff notifications. Owner decision D-7, 2026-08-29.
--
-- A SEPARATE table from `notifications`, deliberately.
--
-- `notifications.type` references `notification_types`, which is the mobile
-- client's own catalogue adopted wholesale, and which drives the six categories
-- an applicant can mute in Settings. Adding staff types to it would put an
-- officer's worklist behind an applicant's mute switch, and would break the
-- parity claim that catalogue exists to make -- a claim a spec already checks.
--
-- The semantics differ too. An applicant notice carries `resolved_at`, because
-- opening a notice does not discharge the act it describes. A staff notice is
-- discharged by MOVING THE APPLICATION, which the lifecycle already records, so
-- resolution here would be a second copy of a fact the transition table owns.

create table staff_notification_types (
  type        text primary key,
  -- What the officer is being asked to do about it. Not a priority: a priority
  -- is a judgement, and this is a statement about whether an act is owed.
  requires_act boolean not null
);

insert into staff_notification_types (type, requires_act) values
  ('application-awaiting-you', true),
  ('assessment-overdue',       true),
  ('workflow-changed',         false);

create table staff_notifications (
  id             uuid        primary key default gen_random_uuid(),
  account_id     uuid        not null references accounts (id) on delete cascade,
  type           text        not null references staff_notification_types (type),
  application_id uuid        references applications (id) on delete restrict,

  -- The role the notice was routed to, recorded rather than recomputed. An
  -- officer whose roles change later should still be able to see why they were
  -- told, and D-5 makes the routing rule itself editable -- so recomputing it
  -- afterwards would answer a different question than the one that was asked.
  routed_to_role text        not null,

  title          text        not null,
  body           text        not null,
  deep_link      text,

  created_at     timestamptz not null default now(),
  read_at        timestamptz
);

create index staff_notifications_account_idx on staff_notifications (account_id, created_at desc);
create index staff_notifications_unread_idx  on staff_notifications (account_id)
  where read_at is null;

-- At most ONE UNREAD notice per officer per application.
--
-- Scoped to unread on purpose, and the first version of this was wrong in a way
-- worth recording: it was unique over all time, which suppressed a LEGITIMATE
-- second arrival. An application can re-enter a status -- Payment Under
-- Verification sends one back to Payment Submitted, and Revision Required
-- returns to Under Evaluation -- and the officer is genuinely waiting again.
-- Told once ever, they would never hear about the second arrival.
--
-- Unread-scoped says the useful thing instead: three unread copies of "EB-123
-- is waiting" tell an officer nothing the first did, but once they have read it
-- and the application comes back, that is news.
create unique index staff_notifications_unread_once_idx
  on staff_notifications (account_id, application_id, type)
  where application_id is not null and read_at is null;

comment on column staff_notifications.routed_to_role is
  'the role this notice was addressed to at the time it was written -- accountability for a routing rule that is editable';
