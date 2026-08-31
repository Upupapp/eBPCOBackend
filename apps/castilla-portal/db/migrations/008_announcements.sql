-- The capability the portal's header already advertises. There is a styled
-- Announcements button on every page with no click handler and no route: it is
-- the one place the site promises something that was never built.

-- 'expired' is deliberately NOT a stored status. Expiry is a function of the
-- clock, and storing it would mean a scheduled job that, if it stops, silently
-- keeps expired notices on a government website. The served state is DERIVED;
-- these three are the only states a person actually sets.
create type announcement_status as enum ('draft', 'published', 'withdrawn');

create table announcements (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null check (length(trim(title)) > 0),

  -- PLAIN TEXT. Never HTML, never markup from an editor. The rendered form is
  -- produced server-side at read time from this text, so there is no path by
  -- which a tag someone typed becomes a tag a browser executes.
  body        text not null check (length(trim(body)) > 0),
  category    text not null check (length(trim(category)) > 0),

  status      announcement_status not null default 'draft',
  -- Null while a draft. A FUTURE value is a schedule, and the read queries
  -- compare it to now(), so a scheduled announcement appears on its own without
  -- a deploy and without a job.
  published_at timestamptz,
  expires_at   timestamptz,

  -- Optional, and drawn from TAB 06's document store rather than a second
  -- upload path. `restrict`, because deleting a form out from under a published
  -- announcement would break a link a citizen was given.
  attachment_form_id uuid references forms (id) on delete restrict,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A published announcement without a publication time cannot be ordered,
  -- scheduled, or expired. It is not publishable.
  constraint announcement_published_has_a_time
    check (status <> 'published' or published_at is not null),
  constraint announcement_expires_after_publication
    check (expires_at is null or published_at is null or expires_at > published_at),

  -- Defence in depth behind the plain-text rule above: refuse anything that
  -- opens a tag. A body is prose, and prose does not contain '<a href'.
  constraint announcement_body_is_not_markup
    check (body !~ '<[A-Za-z/!?]')
);

-- The list query's exact shape: published, live, newest first.
create index announcements_published_desc
  on announcements (published_at desc) where status = 'published';

create table announcement_events (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references announcements (id) on delete cascade,
  action          text not null
                  check (action in ('created', 'published', 'withdrawn', 'rescheduled', 'edited')),
  -- Who. Not nullable and not blank: 'an announcement was withdrawn' is not an
  -- audit record, it is a rumour.
  actor           text not null check (length(trim(actor)) > 0),
  reason          text,
  at              timestamptz not null default now()
);

create index announcement_events_by_announcement
  on announcement_events (announcement_id, at desc);

-- Withdrawal must be attributable, enforced by the database rather than by
-- whichever code path happened to do the withdrawing. Deferred, because the
-- status change and its event are written in one transaction and the order
-- between them is not the point.
create or replace function withdrawal_must_be_attributable() returns trigger as $$
begin
  if new.status = 'withdrawn' and not exists (
    select 1 from announcement_events e
     where e.announcement_id = new.id and e.action = 'withdrawn'
  ) then
    raise exception 'announcement % cannot be withdrawn without an event naming who withdrew it',
      new.slug;
  end if;
  return new;
end; $$ language plpgsql;

create constraint trigger announcement_withdrawal_is_attributable
  after insert or update on announcements
  deferrable initially deferred
  for each row execute function withdrawal_must_be_attributable();

comment on column announcements.body is
  'Plain text only. The HTML served to browsers is rendered from this at read '
  'time; no markup is ever accepted or stored.';
