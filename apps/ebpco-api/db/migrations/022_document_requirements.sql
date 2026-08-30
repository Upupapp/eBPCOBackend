-- What each permit type requires an applicant to bring.
--
-- Free text until now: `documents.label` is whatever the uploader typed, so
-- there was no list anywhere of what a Fencing permit actually needs, and no
-- way for an applicant to know before they arrived at the counter.
--
-- NOT the portal's whole `ApplicationTypeRequirements`. That bundle also names
-- a reviewing department per document and an evaluation sequence per permit
-- type; departments do not exist in this service at all, and inventing a
-- department vocabulary to satisfy a field would create a list the LGU never
-- asked for and would then have to keep. The evaluation sequence is the
-- lifecycle's business (TAB 13). This is the checklist and nothing else.
create table document_requirements (
  permit_type  text    not null references permit_types (permit_type) on delete restrict,
  -- Stable across renames. An LGU that rewords "Lot Plan" to "Lot Plan (signed)"
  -- has not created a different requirement, and a label used as an identifier
  -- would make it one.
  code         text    not null check (length(trim(code)) > 0),
  label        text    not null check (length(trim(label)) > 0),
  description  text    not null default '',
  -- False for a document that is asked for only in some circumstances. It still
  -- appears on the checklist, because an applicant who is not told about an
  -- optional document cannot choose to bring it.
  required     boolean not null default true,
  -- The order the LGU wants it read in, which is not alphabetical and is not
  -- insertion order once anything has been edited.
  position     integer not null default 0,

  updated_at   timestamptz not null default now(),
  updated_by   uuid references accounts (id) on delete restrict,

  primary key (permit_type, code)
);

-- WHAT WAS REQUIRED OF THIS APPLICATION, captured when it was filed.
--
-- The checklist changes; a filed application must not. An applicant who
-- submitted everything asked of them in March cannot become non-compliant in
-- April because the LGU added a document — and an officer looking at an old
-- application needs to see the list it was actually judged against.
--
-- Snapshotted rather than versioned. A version pointer would need the whole
-- catalogue kept immutable forever to stay resolvable, which is the machinery
-- the fee schedule needs because a fee is arithmetic that must be reproducible.
-- A checklist is a list; storing the list is simpler than storing a key to it.
alter table applications add column required_documents jsonb;
