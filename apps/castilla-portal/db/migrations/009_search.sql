-- Server-side search across offices and permits.
--
-- Search on this portal is broken in production right now, and the shape of the
-- break is the reason this table exists. The client matches only an office's
-- name and short description, so 'building permit', 'building', 'occupancy' and
-- 'zoning' — four of the likeliest terms on a building-permit portal — all
-- return the empty state, while the office that ISSUES those permits lists them
-- one field away in its services array, and the office that issues the zoning
-- clearance never contains the word 'zoning' at all.
--
-- Two distinct gaps produce those four dead terms: fields that are not searched,
-- and RELATED entities that are not searched. Indexing only the obvious columns
-- reproduces both, so the document below deliberately reaches across the
-- permit -> office relationship.
create table search_documents (
  entity_type text not null check (entity_type in ('office', 'permit')),
  entity_id   uuid not null,

  -- Enough to render a result row without a follow-up call.
  slug        text not null,
  title       text not null,
  summary     text not null,

  -- The office category or the permit office-group, so the portal's existing
  -- filters compose with a query term instead of replacing it.
  facet       text,

  document    tsvector not null,

  primary key (entity_type, entity_id)
);

create index search_documents_gin on search_documents using gin (document);
create index search_documents_facet on search_documents (entity_type, facet);

comment on table search_documents is
  'Rebuilt from the published content by SearchIndexer. It must never contain a '
  'value the read API would withhold: search is not a side channel around the '
  'publication gate.';
