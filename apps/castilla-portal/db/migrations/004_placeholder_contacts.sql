-- The portal marks an office's contact as a placeholder in its source
-- (`placeholderContact()`), and until 2026-08-30 that fact reached the backend
-- only as "all four fields happen to be pending". That is a coincidence, not a
-- record: an office with four genuinely-unsourced real values is
-- indistinguishable from one the LGU has openly declared it has no contact for.
--
-- The distinction matters to the person working the backlog. "We have never
-- had a number for this office" and "we have a number nobody has sourced yet"
-- are different jobs, and only the second is finishable at a desk.
alter table offices
  add column contact_is_placeholder boolean not null default false;

comment on column offices.contact_is_placeholder is
  'True when the portal source declares the office has no confirmed contact, '
  'rather than merely having contact fields that are not yet sourced.';
