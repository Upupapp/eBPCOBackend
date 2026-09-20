-- Reversal for 051_document_provenance.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql.
--
-- LOSSY once anything populates it: an issue date and an issuing office are
-- read off the face of a document by the officer at the counter and derivable
-- from nothing else here. Lossless only while both columns are null everywhere.

begin;

alter table documents drop constraint if exists documents_expiry_after_issue;
alter table documents drop column issued_on, drop column issuing_office;

delete from schema_migrations where version = 51;

commit;
