-- Reversal for 058_returned_documents_replaced.sql.
--
-- Kept in db/rollback/, NOT db/migrations/: `loadMigrations` throws on any .sql
-- file there that does not match NNN_name.sql.
--
-- Lossless: it removes the one precondition 058 added and nothing else. Roll
-- back the service first -- a service that still sends applicants to
-- POST /applications/:id/resubmit would then let a returned document go back
-- unreplaced.

begin;

update lifecycle_transitions
   set preconditions = array_remove(preconditions, 'returned-documents-replaced')
 where from_status = 'Revision Required' and to_status = 'Under Evaluation';

delete from schema_migrations where version = 58;

commit;
