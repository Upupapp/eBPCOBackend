-- Two values the seeder recorded the STATE of and then dropped.
--
-- 1. An office head who is not an elected official had nowhere to live. Only
--    `head_official_id` existed, and it resolves against the elected roster in
--    officials.data.ts. Fifteen of the seventeen confirmed heads are appointed
--    department heads written inline on the office, so field_state said
--    `head: confirmed` for 17 offices while the database could name 2. The
--    portal shows those names today; the API would have served nothing.
--
-- 2. `office_related` was created in 001 and never written to. Every office in
--    the source carries relatedOfficeSlugs.
--
-- Both are the failure that keeps recurring here: a fact's STATE is recorded
-- faithfully while the fact itself is discarded, and no test notices because
-- absent is indistinguishable from "the source didn't say".

alter table offices
  add column head_name     text,
  add column head_position text;

-- A head is EITHER the elected official's own record or a name written on the
-- office. Both at once means two answers to "who runs this office", and the one
-- the API happens to read wins silently.
alter table offices
  add constraint office_head_has_one_source
  check (head_official_id is null or head_name is null);

-- A name without a role is not a head; the portal renders both together.
alter table offices
  add constraint office_head_name_has_a_position
  check ((head_name is null) = (head_position is null));

comment on column offices.head_name is
  'An appointed head written on the office. Mutually exclusive with '
  'head_official_id, which points at the elected roster instead.';

-- The constraint that makes gap 1 unrepeatable. Deferred, because the seeder
-- writes the office and its confirmation state in one transaction and the order
-- between them is not the point.
create or replace function confirmed_head_must_be_nameable() returns trigger as $$
begin
  if new.entity_type = 'office' and new.field_name = 'head' and new.state = 'confirmed'
     and not exists (
       select 1 from offices o
        where o.id::text = new.entity_id
          and (o.head_official_id is not null or o.head_name is not null)
     ) then
    raise exception 'office % has a confirmed head with no name to serve', new.entity_id
      using hint = 'link head_official_id or set head_name/head_position before confirming';
  end if;
  return new;
end; $$ language plpgsql;

create constraint trigger field_state_confirmed_head_is_nameable
  after insert or update on field_state
  deferrable initially deferred
  for each row execute function confirmed_head_must_be_nameable();
