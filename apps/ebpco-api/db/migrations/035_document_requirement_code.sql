-- Which checklist item a document was uploaded to satisfy.
--
-- C-6. `document_requirements` says what a permit type asks for and `documents`
-- holds what was sent, and NOTHING JOINED THEM. So no surface could say which
-- required document was missing without matching on the label -- which is a
-- guess, and `evaluation.service.ts` had already written that conclusion down
-- rather than guessing. The admin front end shipped exactly that fabrication
-- once, as a "Missing Documents" column computed from a hash.
--
-- ── Why there is NO foreign key ───────────────────────────────────────────
--
-- Deliberate, and the reason matters more than the column.
--
-- The authority for a filed application is NOT the live catalogue. Migration
-- 022 snapshots the checklist onto `applications.required_documents` at filing,
-- because the checklist changes and a filed application must not: someone who
-- submitted everything asked of them in March cannot become non-compliant in
-- April because the LGU added a document. A foreign key to
-- `document_requirements (permit_type, code)` would point at what the catalogue
-- says TODAY, which is the wrong list to judge an old application against, and
-- would break the moment an LGU retired a code some filed application still
-- references.
--
-- A document is also uploaded BEFORE its application exists -- `POST /documents`
-- takes a nullable `application_id`, and both clients upload first and file
-- second -- so at write time there is frequently no permit type to key on.
--
-- The code is therefore validated where the snapshot is made, at submission,
-- against the list that application is actually judged against. Same reasoning
-- as `access_request_permit_types`, which carries no key for its own reasons.

alter table documents add column requirement_code text
  check (requirement_code is null or length(trim(requirement_code)) > 0);

comment on column documents.requirement_code is
  'reference:checklist — which entry of applications.required_documents this document answers. Not personal data: an LGU checklist code, identical for every applicant.';

-- The lookup this exists for: the documents on one application, by requirement.
create index documents_requirement_idx
  on documents (application_id, requirement_code)
  where deleted_at is null;

-- ── Null is not "missing" ─────────────────────────────────────────────────
--
-- Every document uploaded before this migration has a null code, and so does
-- any uploaded by a client that does not send one. A null means NOT ATTRIBUTED
-- -- nobody said which requirement it answers -- and it must never be read as
-- evidence that a requirement is unmet. A view that counted requirements with
-- no matching code would report every checklist item missing on an application
-- whose documents all predate this column, which is worse than reporting
-- nothing.
--
-- The read side therefore reports the count of unattributed documents beside
-- any missing list, so nobody can present the second without the first.
