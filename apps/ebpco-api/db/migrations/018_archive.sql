-- Archiving, which is not cancelling.
--
-- Cancelling is a LIFECYCLE act: it ends an application, and the transition
-- table decides who may do it and from where. Archiving is a RECORDS act about
-- visibility only — it takes a finished application out of the working queue so
-- the queue shows work. Conflating them would let an officer end a live
-- application by tidying up.
--
-- Which is why only a terminal application may be archived: an archived
-- in-flight application would disappear from every officer's queue while still
-- owing an act, and the applicant would be waiting on a permit nobody can see.
alter table applications
  add column archived_at      timestamptz,
  add column archived_by      uuid references accounts (id),
  add column archive_remarks  text;

-- The queue reads live applications, which after this is most reads. A partial
-- index costs nothing for the archived rows nobody is listing.
create index applications_live_idx on applications (created_at) where archived_at is null;

-- An archive entry with no actor is an act with nobody responsible for it, and
-- remarks are how the next officer knows why a record was put away.
alter table applications add constraint archive_is_attributable check (
  (archived_at is null and archived_by is null and archive_remarks is null)
  or (archived_at is not null and archived_by is not null)
);
