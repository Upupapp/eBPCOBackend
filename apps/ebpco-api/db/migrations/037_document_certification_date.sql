-- When a document was certified, which is not when it was uploaded.
--
-- The Municipal ruling of 2026-09-03: a reused document past its validity is
-- ACCEPTED, and the officer decides. The admin note must say the document is
-- reused AND THE DATE IT WAS CERTIFIED.
--
-- `documents` held `expires_on` and `uploaded_at` and nothing else about time.
-- Neither answers the question. An expiry cannot say when a thing was
-- certified, and an upload date is the day a file reached this service — the
-- citizen web lane had `certifiedOn` falling back to `uploaded_at` and removed
-- it for exactly that reason: it would have told an officer a document was
-- certified on the day it was uploaded, which is a fabrication in the one
-- direction the ruling exists to protect against.
--
-- ── Nullable, and null everywhere on arrival ─────────────────────────────
--
-- Nobody supplies this yet, and that is deliberate rather than unfinished.
--
-- Who eventually records it — the citizen typing it at upload, or an officer
-- reading it off the face of the document at review — is a workflow decision
-- for the Municipality, and it is with the owner. Shipping the column empty is
-- the position the data actually supports: the officer is told the document is
-- reused and that the certification date is NOT RECORDED, which is a true
-- statement they can act on and is strictly better than today, where they are
-- told nothing at all.
--
-- NULL MEANS NOT RECORDED. It never means the document was not certified, and
-- no surface may render it as a date, a blank that reads as a date, or an
-- expiry standing in for one.
--
-- A date, not a timestamp: this is a date read off the face of an official
-- document, like `expires_on` beside it, not an instant this service observed.

alter table documents add column certified_on date;

comment on column documents.certified_on is
  'pii:document:certification — when the issuing office certified this document, read off its face. Null means NOT RECORDED.';

-- The admin note is built from this, so the officer's document row reads it on
-- every application it renders.
create index documents_certified_on_idx
  on documents (application_id, certified_on)
  where deleted_at is null;
