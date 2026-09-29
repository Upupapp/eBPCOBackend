-- 062: a team lead and team members for every office, and archive -- never
-- delete -- for everything (owner request, 2026-09-29).
--
-- ── Teams ──────────────────────────────────────────────────────────────────
--
-- A team is an office: the officers holding one position (Initial Evaluator,
-- Cashier, ...). Membership is not stored -- it is the position, read from the
-- account's roles and evaluation stages, so a second answer to "which team"
-- cannot drift from what the server lets the officer do. What IS stored is who
-- leads: `team_role` on the officer's access row. A lead leads every team their
-- position puts them in.
--
-- Every officer can READ every application. An officer can WORK on one (edit
-- its particulars, review its documents, decide its stage, move it on) only
-- while it is at their team's step, and -- once it is assigned -- only when it
-- is assigned to them. A lead can work on anything at their team's step, and
-- assigns or reassigns it. An unassigned application is taken by the first
-- member who works on it.

alter table staff_access
  add column team_role text not null default 'member'
    check (team_role in ('lead', 'member'));

comment on column staff_access.team_role is
  'lead: leads the team(s) of this officer''s position -- assigns its applications and may work on any of them. member: works on unassigned applications at the team''s step and on those assigned to them.';

-- Who is working an application, per team. Keyed by team, not by status, so an
-- application returned to a team (a revision loop) goes back to the officer who
-- had it, and moving on to the next team leaves the previous assignment as a
-- record rather than something to clean up.
create table application_assignments (
  application_id uuid        not null references applications (id) on delete restrict,
  team           text        not null check (team in (
                   'receiving', 'initial-evaluation', 'zoning', 'fire-safety', 'technical',
                   'assessment', 'cashier', 'building-official', 'releasing')),
  assigned_to    uuid        not null references accounts (id),
  assigned_by    uuid        not null references accounts (id),
  assigned_at    timestamptz not null default now(),
  primary key (application_id, team)
);

create index application_assignments_by_assignee on application_assignments (assigned_to);

-- ── Archive, never delete ──────────────────────────────────────────────────
--
-- Owner ruling 2026-08-31 said "archive only"; this finishes it. Nothing an
-- officer -- a super admin included -- can reach deletes a row any more, and
-- everything archived can be restored.

-- Accounts. `removed_at` (057) was a staff-only retirement; it is now the
-- archive for every account, citizens included, with the reason given. A
-- removed account is still always disabled (057's constraint stays).
alter table accounts drop constraint removed_accounts_are_staff;
alter table accounts add column removed_reason text;

comment on column accounts.removed_at is
  'Archived: set aside by an officer, with removed_by and removed_reason. The row stays, cannot sign in, and can be restored. Staff and citizen accounts alike.';

-- Businesses. Separate from `status` (Active / Inactive), which is the
-- business's own standing; archiving takes the record out of the working list.
alter table businesses
  add column archived_at    timestamptz,
  add column archived_by    uuid references accounts (id),
  add column archive_reason text;

alter table businesses
  add constraint business_archive_is_attributed check ((archived_at is null) = (archived_by is null));

-- Checklist documents. Saving a checklist used to delete the documents it no
-- longer listed; they are now archived, and one saved back in comes back.
alter table document_requirements
  add column archived_at timestamptz,
  add column archived_by uuid references accounts (id);

-- Permit types: who retired one, for the Archive list.
alter table permit_types add column retired_by uuid references accounts (id);
