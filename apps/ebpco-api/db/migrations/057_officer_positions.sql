-- Officer positions: which EVALUATION STAGES an evaluator may decide, and a
-- way for a super admin to remove a staff account from the directory.
--
-- ── Stages ──────────────────────────────────────────────────────────────
--
-- `staff:evaluate` let any evaluator decide any of the five stages. In the
-- office these are different people in different offices: the Zoning stage
-- is the MPDO's, Fire Safety is the Bureau of Fire Protection's, OBO is the
-- Building Official's technical staff, Final Approval is the Building Official
-- — and a BFP inspector passing the structural review is exactly the record
-- this system exists to prevent. The owner asked for it outright (2026-09-26):
-- a fire safety officer approves the fire safety evaluation and no other.
--
-- A table keyed by account and stage, for the reason `staff_permit_access`
-- (migration 032) gives: which stage an officer may decide is a question
-- about THIS application's next stage, a domain question, not a scope to mint
-- into every token. Empty means none, never all — the same fail-closed rule.
-- Super admins are not listed here; the service treats that role as holding
-- every stage, as it already holds every scope.
create table staff_evaluation_stages (
  account_id  uuid not null references accounts (id) on delete cascade,
  stage       text not null
    check (stage in ('Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval')),
  granted_by  uuid not null references accounts (id),
  granted_at  timestamptz not null default now(),
  primary key (account_id, stage)
);

create index staff_evaluation_stages_by_stage on staff_evaluation_stages (stage);

-- ── Removing a staff account ────────────────────────────────────────────
--
-- A staff account whose name is on a decision cannot be deleted: the audit
-- trail, the evaluations and the notes all point at it, and erasing it would
-- leave permits decided by nobody (erasure refuses staff accounts for exactly
-- this reason). So "delete" is two things. An account that never did anything
-- is deleted outright. One that did is RETIRED: disabled for good, hidden from
-- the directory and from every "assigned to" list, and kept — name and all —
-- so every decision it made still says who made it.
alter table accounts
  add column removed_at timestamptz,
  add column removed_by uuid references accounts (id);

alter table accounts
  add constraint removed_accounts_are_staff check (removed_at is null or kind = 'staff'),
  add constraint removed_accounts_are_disabled check (removed_at is null or disabled_at is not null),
  add constraint removal_is_attributed check ((removed_at is null) = (removed_by is null));

comment on column accounts.removed_at is
  'Set when a super admin removed this staff account from the directory. The row stays so the '
  'decisions it made remain attributed; it can never sign in again.';
