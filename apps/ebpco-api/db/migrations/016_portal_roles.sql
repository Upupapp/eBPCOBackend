-- WP-01: the staff web portal and this service grew separate role vocabularies.
-- Reconciled toward THIS table's names (see PORTAL_ROLE_LABELS), which needs
-- two roles the portal has and this service did not.
--
-- The check constraint is the reason this is a migration rather than a
-- TypeScript edit. `StaffRole` gaining a member does not teach the database
-- anything: inserting 'auditor' would have been refused at the constraint, at
-- runtime, in whatever code path first tried to grant it. The type and the
-- constraint are two statements of one fact and both have to be changed.
alter table account_roles drop constraint account_roles_role_check;

alter table account_roles add constraint account_roles_role_check check (role in (
  'receiving-officer', 'records-officer', 'evaluator', 'assessor',
  'cashier', 'building-official', 'releasing-officer', 'administrator',
  -- Read everything, change nothing. Oversight without authority, which no
  -- existing role could express: every role that could read could also act.
  'auditor',
  -- The portal's Super Admin. Every read scope plus administration, and
  -- deliberately none of the four acting scopes -- see ROLE_SCOPES for why
  -- collapsing them would dissolve the separation of duty this table enforces.
  'super-admin'));
