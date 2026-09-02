-- Reversal for 035_document_requirement_code.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql.
--
-- LOSSY. Every attribution made since 035 shipped lives only in this column --
-- it is not derivable from anything else, which is the whole reason the column
-- exists. Dropping it returns the service to matching on labels, which is to
-- say to guessing.

begin;

drop index if exists documents_requirement_idx;
alter table documents drop column requirement_code;

delete from schema_migrations where version = 35;

commit;
