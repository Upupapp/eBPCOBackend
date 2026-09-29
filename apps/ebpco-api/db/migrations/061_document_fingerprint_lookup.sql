-- 061: finding a citizen's copies of one file by its fingerprint (owner
-- request, 2026-09-29: "don't let the user upload the same document, just say
-- they should reuse it").
--
-- `documents.sha256` has been recorded since 004 (of the bytes actually kept,
-- after metadata scrubbing). An upload is now refused when the same citizen
-- already has that file in My Documents, and My Documents shows each file once
-- however many applications carry a copy. Both look a file up by (uploader,
-- fingerprint); this is the index for it. Deleted copies are never looked up.

create index documents_uploader_fingerprint
  on documents (uploaded_by, sha256)
  where deleted_at is null;
