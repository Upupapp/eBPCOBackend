-- TAB 01 — provenance and confirmation, per FIELD.
--
-- ── Why per field and not per record ─────────────────────────────────────
--
-- Because the data already is. One office carries different provenance for its
-- head than for its telephone. One office has a CONFIRMED `hours` value inside
-- an otherwise unconfirmed contact. A record-level flag cannot express either,
-- and that is precisely why the current front end string-matches the literal
-- 'Pending confirmation' -- the coarse flag forced a sentinel into the data,
-- and TAB 03 forbids reproducing it in an API.

create table field_state (
  entity_type  text not null,
  entity_id    text not null,
  field_name   text not null,
  state        confirmation_state not null default 'pending',
  updated_at   timestamptz not null default now(),
  primary key (entity_type, entity_id, field_name)
);

-- The primary key above is also what makes TAB 02's concurrency requirement
-- satisfiable: two confirmations of one field cannot both win, because there is
-- one row to update and the transaction that loses sees it.

create table provenance (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    text not null,
  field_name   text not null,
  -- Where it came from, in words a person can check.
  source_description text not null,
  source_url   text,
  sourced_on   date not null,
  method       provenance_method not null,
  recorded_at  timestamptz not null default now(),

  -- 'LGU' is not a source. A proposal carrying an empty or near-empty
  -- description must not reach a confirmed field, and the shortest defensible
  -- description is longer than four characters.
  constraint provenance_description_is_real check (length(trim(source_description)) >= 8)
);

-- NO foreign key from provenance to the entity, and NO cascade.
--
-- Losing why a fact was published is worse than an orphan row. An office
-- deleted in five years leaves its provenance behind deliberately, because the
-- question "why did the portal once say this" outlives the record.
create index provenance_field_idx on provenance (entity_type, entity_id, field_name, sourced_on);

-- ── Confirmed implies provenance, enforced by the database ───────────────
--
-- TAB 01 is explicit that this is a constraint and not a convention. It cannot
-- be a CHECK, because a CHECK cannot see another table; it is a trigger, which
-- is the same guarantee by the only mechanism PostgreSQL offers.
--
-- CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED: the confirmation and its
-- provenance row are written in one transaction and the order within that
-- transaction should not matter. An immediate trigger would force the caller to
-- insert provenance first, which is a rule about statement order masquerading
-- as a rule about data.
create or replace function confirmed_requires_provenance() returns trigger as $$
begin
  if new.state = 'confirmed' and not exists (
    select 1 from provenance p
     where p.entity_type = new.entity_type
       and p.entity_id   = new.entity_id
       and p.field_name  = new.field_name
  ) then
    raise exception
      'field %.%.% cannot be confirmed without a provenance record',
      new.entity_type, new.entity_id, new.field_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger field_state_confirmed_requires_provenance
  after insert or update on field_state
  deferrable initially deferred
  for each row execute function confirmed_requires_provenance();

-- ── Office contacts ──────────────────────────────────────────────────────
--
-- One row per field rather than one row with four columns, so `telephone` and
-- `hours` carry independent state through `field_state` above.
create table office_contacts (
  office_id   uuid not null references offices (id) on delete cascade,
  field_name  text not null check (field_name in ('telephone', 'email', 'location', 'hours')),
  value       text not null,
  -- Whether this address or number belongs to an OFFICE or to a named person.
  --
  -- The owner's ruling (2026-08-30) is that personal contacts are withheld and
  -- institutional ones published. That ruling is enforced by `field_state`;
  -- this column is what makes it decidable, and it is not nullable because
  -- "we did not look" and "it is institutional" must not be the same answer.
  is_institutional boolean not null,
  primary key (office_id, field_name)
);
