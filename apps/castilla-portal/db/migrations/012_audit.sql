-- Who changed what, when, and on what basis.
--
-- Provenance answers "where did this fact come from". Audit answers "who put it
-- there". Together they are why a disputed statement about a named official can
-- be resolved rather than argued about.
create table audit_log (
  id            bigserial primary key,
  at            timestamptz not null default now(),

  -- Never null and never blank. 'Someone confirmed the Mayor's name' is not an
  -- audit record; TAB 11 exists so that there is always a name to put here.
  actor         text not null check (length(trim(actor)) > 0),
  action        text not null check (length(trim(action)) > 0),

  entity_type   text not null,
  entity_id     text not null,
  field_name    text,

  -- Recorded IN FULL, always. Redaction happens at READ time: a contact
  -- withdrawn next year must not blank out the record of it having been
  -- published, or the trail stops being able to answer what the site said.
  prior_value   text,
  new_value     text,

  -- The provenance row a confirmation rested on, so 'who confirmed it' and 'on
  -- what source' are one hop apart rather than a join nobody remembers to make.
  provenance_id uuid references provenance (id) on delete restrict,

  detail        text
);

create index audit_log_by_entity on audit_log (entity_type, entity_id, at);
create index audit_log_by_actor  on audit_log (actor, at desc);

-- APPEND-ONLY, enforced by the database rather than by discipline.
--
-- Two mechanisms, because they cover different attackers. The trigger applies
-- to EVERY role including the superuser the tests and local development run as,
-- so the guarantee is demonstrable here. The REVOKE below is what constrains
-- the application's own role in production, where it is not a superuser.
create or replace function audit_is_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using hint = 'Correct a mistaken entry by appending a correcting row.';
end; $$ language plpgsql;

create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function audit_is_append_only();

-- Truncate bypasses row triggers entirely, so it needs its own.
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_is_append_only();

-- The production application role. Created here so the grant is part of the
-- schema rather than a runbook step somebody skips.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'castilla_portal_app') then
    create role castilla_portal_app nologin;
  end if;
end $$;

grant insert, select on audit_log to castilla_portal_app;
revoke update, delete, truncate on audit_log from castilla_portal_app;
grant usage, select on sequence audit_log_id_seq to castilla_portal_app;

comment on table audit_log is
  'Append-only. Enforced by trigger for every role, and by REVOKE for '
  'castilla_portal_app. Correct a mistaken entry by appending, never by editing.';
