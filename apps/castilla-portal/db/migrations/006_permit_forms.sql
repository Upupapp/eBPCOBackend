-- The application form and checklist a citizen downloads.
--
-- 14 of the 19 permits have a bundled form and 5 do not, and that 5 is a FACT
-- about what the LGU publishes rather than a gap to be filled: a permit with no
-- form is filed at the counter. So the columns are nullable and the API omits
-- them, exactly as it omits an unconfirmed head — the client must render
-- without a download link rather than with a broken one.
alter table permits
  add column form_url      text,
  add column checklist_url text;

-- Both are paths into the portal's own bundled assets. A permit pointing at an
-- absolute URL would be this API sending citizens off-site for a government
-- form, which is how a phishing page gets a foothold.
alter table permits
  add constraint permit_form_url_is_local
  check (form_url is null or form_url like '/assets/permits/%');

alter table permits
  add constraint permit_checklist_url_is_local
  check (checklist_url is null or checklist_url like '/assets/permits/%');

comment on column permits.form_url is
  'The bundled application form, or NULL where the LGU publishes none. '
  'NULL is a published fact, not a missing value.';
