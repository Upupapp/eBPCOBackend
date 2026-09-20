-- Reversal for 049_citizen_administration.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any
-- .sql file there that does not match NNN_name.sql.
--
-- LOSSY once anything populates `disabled_reason`: a staff-entered reason is
-- not derivable from anything else in this schema, which is the whole reason
-- the column exists. Lossless today, on a fresh migrate, and for as long as
-- no disable has used it yet.

begin;

drop index if exists applicants_name_lower_idx;
alter table accounts drop column disabled_reason;

delete from schema_migrations where version = 49;

commit;
