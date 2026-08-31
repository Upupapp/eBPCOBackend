-- Reversal for 032_staff_access_control.sql.
--
-- Kept in db/rollback/, NOT db/migrations/. `loadMigrations` throws on any .sql
-- file in the migrations directory that does not match NNN_name.sql, so a
-- rollback script filed beside the migrations would stop every deployment.
--
-- NOT a down-migration and not run by the migrator: `scripts/migrate.ts` states
-- why there is no `down`, and nothing here changes that. This is the SQL an
-- operator would run by hand, written out because "additive and therefore
-- reversible" is a claim that should be checkable rather than asserted.
--
-- It is lossless in one direction only: it removes access control and returns
-- every staff account to the pre-032 behaviour of seeing every permit type.
-- The access requests it drops are a record of who asked for what, so EXPORT
-- THEM FIRST if the rollback is anything other than an immediate undo.
--
--   \copy (select * from access_requests) to 'access_requests.csv' csv header
--
-- 031 and earlier are untouched: 032 dropped nothing and rewrote nothing.

drop table if exists access_request_attempts;
drop table if exists access_request_permit_types;
drop table if exists access_requests;
drop table if exists staff_permit_access;
drop table if exists staff_access;

-- Safe: 032 added this column and nothing before it reads it.
alter table permit_types drop column if exists retired_at;

-- `version` is an INTEGER in the ledger, not a zero-padded string: the loader
-- parses it with Number(). '032' would delete nothing and leave the migrator
-- refusing to re-apply.
delete from schema_migrations where version = 32;
