-- The audit trail's tamper-evidence.
--
-- Each entry commits to the one before it, so removing or editing any row
-- breaks every row after it and a single pass detects it. This is not a
-- substitute for write-once storage: someone with database superuser rights
-- could recompute the whole chain. What it does is raise tampering from one
-- UPDATE, which nobody would notice, to rewriting every row since.

-- The chain head, in one row, locked on every append.
--
-- Without this, two concurrent appends both read the same previous hash and
-- produce two entries claiming the same predecessor, which is indistinguishable
-- from a forgery. Serialising appends is the cost of the chain meaning anything.
create table audit_chain_head (
  id            integer primary key default 1,
  last_hash     text    not null,
  last_sequence bigint  not null default 0,

  constraint audit_chain_head_is_a_single_row check (id = 1)
);

insert into audit_chain_head (id, last_hash, last_sequence)
values (1, 'genesis', 0);

-- Sequence position, so the chain has an order independent of insertion time:
-- two events in the same millisecond still have a defined predecessor.
alter table audit_events add column sequence bigint;
create unique index audit_events_sequence_idx on audit_events (sequence);
