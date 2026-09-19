-- A citizen's own profile photo — User Portal Profile screen.
--
-- On `accounts`, not `applicants`: unlike a name or address, a profile photo
-- is not part of a permit record (PD 1096 has no interest in what a citizen
-- looks like), it is an account-level convenience the same way an avatar is
-- on any web service. That is also what makes it safe to erase outright on
-- request (RA 10173 s.16(e)) rather than surviving as part of the record the
-- way `applicants.first_name`/`street`/etc. deliberately do — see
-- erasure.service.ts, which now clears these two columns in the same UPDATE
-- that already pseudonymises the rest of this row.
--
-- Two columns, not one: `photo_content_type` is needed to serve the bytes
-- back with the right header without re-sniffing them on every read, and the
-- pair is kept in lockstep by the check constraint below rather than by
-- application code remembering to write both or neither.
--
-- The bytes themselves live in the object store, never the database — the
-- same architecture `documents.storage_key` already uses, for the same
-- reason: this column is an opaque, non-enumerable key (`newObjectKey()`),
-- not a path or a filename.

alter table accounts
  add column photo_key text,
  add column photo_content_type text
    check (photo_content_type is null or photo_content_type in ('image/jpeg', 'image/png')),
  add constraint photo_key_and_type_together
    check ((photo_key is null) = (photo_content_type is null));

-- Deliberately NOT `pii:`-tagged, the same as `documents.storage_key`: an
-- opaque, non-enumerable object-store key discloses nothing about the person
-- it belongs to on its own. The sensitivity lives in what it points AT —
-- see personal-data.ts's own comment on this column for where that is
-- accounted for.
comment on column accounts.photo_key is
  'a reference into the object store, not personal data on its own — see personal-data.ts';
comment on column accounts.photo_content_type is
  'not personal data on its own — a MIME type, kept alongside photo_key only to serve the bytes back correctly';
