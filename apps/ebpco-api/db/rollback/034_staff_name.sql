-- Reversal for 034_staff_name.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql.
--
-- LOSSY for any name typed after 034 shipped. A name recovered by 034's
-- backfill still exists in `access_requests` and can be recovered again; a name
-- edited or set directly on an account afterwards exists only in this column
-- and is destroyed by dropping it. That is the whole of the loss, and it is
-- named rather than discovered.

begin;

alter table accounts drop column full_name;

delete from schema_migrations where version = 34;

commit;
