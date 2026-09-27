-- Reversal for 059_document_resubmitted_notice.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql. Lossy: the notices of this type
-- are deleted with it.

begin;

delete from staff_notifications where type = 'document-resubmitted';
delete from staff_notification_types where type = 'document-resubmitted';

delete from schema_migrations where version = 59;

commit;
