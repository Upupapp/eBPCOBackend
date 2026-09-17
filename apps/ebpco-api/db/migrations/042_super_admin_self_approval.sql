-- Super Admin may approve an assessment it prepared or submitted itself.
--
-- Owner request: this account already holds every acting scope in the
-- workflow (receive, evaluate, assess, verify-payment, approve, release), so
-- the four-eyes rule the rest of the office lives under -- "a different
-- officer must approve" -- is lifted for it specifically. Every other role
-- is unaffected: an assessor or administrator still cannot approve their own
-- draft.
--
-- A plain CHECK constraint cannot query another table, so
-- `approver_is_not_the_assessor` (019_assessments.sql) is replaced with a
-- trigger that can look the approver's role up in `account_roles` --
-- mirroring `reject_role_on_applicant()` in 001_identity.sql for the same
-- reason: a bug that has to defeat a lookup is a much harder bug to write
-- than one that has to defeat a widened comparison.

alter table assessments drop constraint approver_is_not_the_assessor;

create or replace function approver_is_not_the_assessor_unless_super_admin() returns trigger as $$
begin
  if new.approved_by is not null
     and (new.approved_by = new.created_by or new.approved_by = new.submitted_by)
     and not exists (
       select 1 from account_roles where account_id = new.approved_by and role = 'super-admin'
     )
  then
    raise exception
      'account % prepared or submitted this assessment and is not Super Admin, so it may not approve it',
      new.approved_by
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger assessments_approver_is_not_the_assessor
  before insert or update on assessments
  for each row execute function approver_is_not_the_assessor_unless_super_admin();
