-- The officer's verdict on a single document, on the document's own record.
--
-- Owner decision, 2026-08-28: a document is turned back **on its own record**,
-- not only through a Letter of Instruction — and it carries a **standard,
-- reusable reason** plus **custom feedback** written for this applicant.
--
-- ── Why this is NOT a widening of `documents.status` ──────────────────────
--
-- `documents.status` looks like the obvious place and is the wrong one. It is
-- the SCAN pipeline's column: `DocumentService.applyVerdict` writes
-- `status = 'Rejected', scan_cleared = false` when the malware scanner
-- quarantines a file, and `retrieve` refuses the bytes on exactly that value.
-- Its four values are 'Approved', 'Rejected', 'Missing', 'Pending'.
--
-- Widening that column to the portal's eight-value evaluation vocabulary would
-- conflate two unrelated verdicts on one axis. An officer marking a document
-- 'Rejected' would make its bytes unretrievable as though it carried malware;
-- a quarantined file would surface to the applicant as an evaluation outcome
-- with a reason the officer never wrote. So the review lives in its own
-- columns and `documents.status` is left exactly as it was.
--
-- ── The vocabulary is the portal's, verbatim ──────────────────────────────
--
-- Eight values, matching `DocumentStatus` in the admin's document.model.ts and
-- the mobile client's `DocumentStatus` enum. Both clients already parse these
-- and both reject an unknown value rather than defaulting, so a spelling that
-- drifts here fails loudly at the client instead of being silently coerced.
alter table documents
  add column review_status text
    check (review_status in ('Missing', 'Uploaded', 'Submitted', 'Under Review',
                             'Accepted', 'Rejected', 'Revision Required', 'Expired'));

comment on column documents.review_status is
  'The officer''s verdict. NULL until anyone has looked. Distinct from documents.status, which is the malware-scan pipeline.';

-- ── Standard, reusable feedback ───────────────────────────────────────────
--
-- The reasons an office turns a document back are the same few, over and over:
-- not a certified true copy, illegible, expired, unsigned. Free text alone
-- makes every officer retype them, spells them differently each time, and
-- leaves nothing countable — an LGU cannot answer "what do we reject most?"
-- from a text column.
--
-- A catalogue, not an enum, because this list is the LGU's to edit. An enum
-- would need a migration every time an office learns a new way to be
-- disappointed.
create table document_review_reasons (
  code        text primary key check (length(trim(code)) > 0),
  label       text not null check (length(trim(label)) > 0),
  description text not null default '',
  -- Retired rather than deleted: a reason cited on a document filed last year
  -- must still render, and deleting it would either break that row or rewrite
  -- history.
  active      boolean not null default true,
  position    integer not null default 0,
  updated_at  timestamptz not null default now()
);

insert into document_review_reasons (code, label, description, position) values
  ('not-certified-true-copy', 'Not a certified true copy',
   'A plain photocopy was submitted where the office requires a certified true copy.', 10),
  ('illegible',               'Illegible',
   'The scan or photograph cannot be read.', 20),
  ('incomplete',              'Incomplete',
   'Pages are missing, or a required section was left blank.', 30),
  ('expired',                 'Expired',
   'The document was valid but its own validity period has passed.', 40),
  ('unsigned',                'Not signed or notarised',
   'A wet signature or notarisation the office requires is absent.', 50),
  ('wrong-document',          'Wrong document',
   'What was uploaded is not the document this requirement asks for.', 60),
  ('mismatched-details',      'Details do not match',
   'Names, lot numbers or areas disagree with the rest of the application.', 70),
  ('other',                   'Other',
   'Anything the standard reasons do not cover. Requires custom feedback.', 999);

alter table documents
  add column review_reason_code text references document_review_reasons (code) on delete restrict;

-- ── Custom feedback, alongside the standard reason ────────────────────────
--
-- The owner asked for both, and both earn their place. The code is what the
-- LGU can count and what the client renders consistently; the remark is what
-- tells THIS applicant what is wrong with THIS document. "Illegible" does not
-- say which page.
alter table documents add column review_remark text;

alter table documents
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references accounts (id) on delete restrict;

comment on column documents.review_remark is
  'pii:document:review — free text about a named applicant''s submission';

-- ── An adverse verdict must say why ───────────────────────────────────────
--
-- The same rule `instruction_items.remark` and `evaluations` already enforce:
-- "Rejected" with no reason leaves the applicant to guess, and guessing is
-- another trip to the office. Either half satisfies it — a standard code is a
-- reason — except 'other', which by definition carries no meaning of its own
-- and must be accompanied by the custom text.
alter table documents add constraint adverse_review_has_reason check (
  review_status not in ('Rejected', 'Revision Required')
  or review_reason_code is not null
  or (review_remark is not null and length(trim(review_remark)) > 0)
);

alter table documents add constraint other_reason_needs_remark check (
  review_reason_code is distinct from 'other'
  or (review_remark is not null and length(trim(review_remark)) > 0)
);

-- A verdict has an author and a moment, or it has neither.
alter table documents add constraint reviewed_together check (
  (review_status is null and reviewed_at is null and reviewed_by is null)
  or (review_status is not null and reviewed_at is not null)
);

-- ── The resubmission chain ────────────────────────────────────────────────
--
-- A replacement is a NEW row pointing at what it replaces, never an update of
-- the old one. The office keeps every submission and so must this: an
-- applicant who resubmits a rejected title should not lose the record of what
-- was rejected, or why, and an officer needs to see what changed.
alter table documents
  add column supersedes_document_id uuid references documents (id) on delete restrict;

-- One replacement per superseded document. Two rows both claiming to replace
-- the same one is an ambiguity nothing downstream could resolve.
create unique index documents_supersedes_unique
  on documents (supersedes_document_id) where supersedes_document_id is not null;

-- A document cannot replace itself.
alter table documents add constraint supersedes_not_self
  check (supersedes_document_id is distinct from id);

-- The applicant's outstanding work, which is the query the detail screen and
-- the action stack both run.
create index documents_needs_action_idx on documents (application_id)
  where deleted_at is null and review_status in ('Rejected', 'Revision Required');
