-- TAB 02 — moving a fact from pending to confirmed, with its source.
--
-- This is the TAB that decides whether the LGU can maintain its own site. The
-- backlog it exposes is not a report; it is the project plan for bringing this
-- portal to publishable, and it needs a workflow rather than a developer
-- editing seed files.

create type proposal_status as enum ('open', 'confirmed', 'rejected', 'superseded');

create table proposals (
  id            uuid primary key default gen_random_uuid(),

  entity_type   text not null,
  entity_id     text not null,
  field_name    text not null,

  -- What the field would become. Proposals are NOT live: nothing reads this
  -- until a confirmation moves it into the record.
  proposed_value text not null,
  -- What it was when the proposal was made. Kept so that reverting has
  -- somewhere to go back to, and so a reviewer can see the change rather than
  -- just its result.
  previous_value text,

  -- The provenance payload, mandatory at proposal time rather than at
  -- confirmation. A proposal that cannot say where its value came from is not
  -- a proposal anyone can act on, and asking for the source later means asking
  -- the confirmer to vouch for a fact they did not find.
  source_description text not null,
  source_url    text,
  sourced_on    date not null,
  method        provenance_method not null,

  status        proposal_status not null default 'open',

  proposed_by   text not null,
  proposed_at   timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,

  -- 'LGU' is not a source. The same floor as the provenance table, applied
  -- where a person types rather than where a seeder writes.
  constraint proposal_description_is_real check (length(trim(source_description)) >= 8),

  -- A decision without a decider is an audit trail that records that "someone"
  -- confirmed the Mayor's name.
  constraint proposal_decision_is_attributable check (
    (status = 'open' and decided_by is null and decided_at is null)
    or (status <> 'open' and decided_by is not null and decided_at is not null)
  )
);

-- At most one OPEN proposal per field. Two people proposing different values
-- for the Mayor's name is a conversation to have before either is confirmed,
-- not a race to confirm first.
create unique index proposals_one_open_per_field
  on proposals (entity_type, entity_id, field_name)
  where status = 'open';

create index proposals_backlog_idx on proposals (status, entity_type, entity_id);

-- ── Reverting keeps the trail ────────────────────────────────────────────
--
-- A confirmed field returned to pending keeps its prior value and its
-- provenance as history. The LGU will contradict itself occasionally -- a
-- Citizen's Charter naming a Treasurer who has since been advertised as a
-- vacancy is already in the source data -- and the trail is how that is
-- resolved rather than argued about.
--
-- Provenance is append-only by construction: nothing in this schema updates or
-- deletes a provenance row, so the history is what accumulates there, ordered
-- by sourced_on and recorded_at.
create table field_value_history (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    text not null,
  field_name   text not null,
  value        text not null,
  state        confirmation_state not null,
  proposal_id  uuid references proposals (id) on delete restrict,
  -- Who. A trail that records that "someone" confirmed the Mayor's name is not
  -- an audit trail, and a revert has an author exactly as a confirmation does.
  recorded_by  text not null,
  recorded_at  timestamptz not null default now()
);

create index field_value_history_idx
  on field_value_history (entity_type, entity_id, field_name, recorded_at);
