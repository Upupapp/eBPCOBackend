-- Reversal for 037_document_certification_date.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql.
--
-- LOSSY once anything populates it. A certification date is read off the face
-- of a document by a person; it is derivable from nothing else in this service,
-- which is the whole reason the column exists. Today it is null everywhere, so
-- this is currently lossless — that stops being true the moment the workflow
-- decision is made and someone starts recording them.

begin;

drop index if exists documents_certified_on_idx;
alter table documents drop column certified_on;

delete from schema_migrations where version = 37;

commit;
