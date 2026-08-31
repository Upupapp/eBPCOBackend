-- The blank application forms a citizen downloads, fills in, and presents at a
-- counter. Serving a stale or wrong one has a cost outside the software, so the
-- bytes, their checksum and the revision printed on the page are all stored.
--
-- The bytes live HERE rather than as a path into the portal's build output,
-- because "superseding a form must keep the prior revision retrievable" is not
-- satisfiable by a pointer at a file the next deploy overwrites. An application
-- filed on last year's form is still a real application.
create table forms (
  id                uuid primary key default gen_random_uuid(),
  -- The stable identity of a form ACROSS revisions. Revision 2 of the zoning
  -- form is the same form as revision 1, and a citizen's link must not break.
  family_slug       text not null,
  original_filename text not null,
  content_type      text not null default 'application/pdf',
  byte_size         int  not null check (byte_size > 0),
  page_count        int  not null check (page_count > 0),
  -- sha256 of the bytes exactly as received. These are the LGU's documents and
  -- are never re-generated, flattened or re-exported, so the checksum of what
  -- is served equals the checksum of what was given.
  checksum          text not null check (checksum ~ '^[0-9a-f]{64}$'),
  -- The revision identifier PRINTED ON THE FORM, where the form prints one.
  -- 10 of the 13 do not, and NULL says so rather than inventing 'v1'.
  revision_label    text,
  bytes             bytea not null,
  imported_at       timestamptz not null default now(),
  superseded_at     timestamptz,

  -- Re-importing an unchanged file must create no new revision.
  constraint forms_family_checksum_is_unique unique (family_slug, checksum)
);

-- Exactly one current revision per family, enforced rather than assumed: two
-- rows claiming to be current is the state in which a citizen's download
-- depends on which row the query happened to read first.
create unique index forms_one_current_per_family
  on forms (family_slug) where superseded_at is null;

-- Many-to-many ON PURPOSE. One file — the Building Permit Unified Application
-- Form — is shared by three building permit variants. Duplicating the bytes
-- once per permit would give the same document three checksums and three
-- independent chances to go stale.
create table permit_forms (
  permit_id  uuid not null references permits (id) on delete cascade,
  form_id    uuid not null references forms (id)   on delete restrict,
  -- 'application' is the form you file; 'checklist' is the list of what to
  -- bring with it. Different things, and the portal renders them separately.
  role       text not null check (role in ('application', 'checklist')),
  primary key (permit_id, form_id, role)
);

create index permit_forms_by_form on permit_forms (form_id);

comment on column forms.revision_label is
  'The revision identifier printed on the form itself, e.g. '
  'BFP-QSF-FSED-001 REV.02 (08.24.20). NULL where the form prints none.';
