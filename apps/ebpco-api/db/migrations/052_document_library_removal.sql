-- 052: a citizen removing a document from "My Documents" without touching
-- what it is already doing duty on.
--
-- `deleted_at` (migration 004) is a real deletion: the object bytes are
-- purged from the store, and every query that reads a document — including
-- the one an application's own document list uses to show what was filed —
-- filters it out. That is correct for a document nothing else references,
-- which is the only case DocumentService.deleteMine allowed until now.
--
-- A citizen removing an ATTACHED document from their reusable library wants
-- something narrower: stop offering it for reuse on a NEW application, while
-- the one it is already filed on keeps showing it exactly as submitted —
-- same bytes, same record, nothing an officer reviewing that application
-- would ever see change. Reusing `deleted_at` for that would purge the
-- bytes an already-filed application still needs to show.
--
-- Nullable, checked only by `GET /documents/me` (the library listing) —
-- every other query (an application's own document list, content serving,
-- staff review) is deliberately left unaware this column exists.
alter table documents
  add column removed_from_library_at timestamptz;

comment on column documents.removed_from_library_at is
  'Set when a citizen removes this copy from "My Documents" while it is still attached to an application. Excluded from the library listing only — the object bytes, the application''s own document list, and everything staff sees are untouched. Never set alongside deleted_at (that is a real deletion, this is not).';
