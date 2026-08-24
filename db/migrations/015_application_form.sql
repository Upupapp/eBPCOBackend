-- The applicant's own answers, which were being thrown away.
--
-- `POST /applications` accepted a `form` object, the contract described it, the
-- mobile wizards fill it in over fifteen or more screens — and nothing stored
-- it. It reached the controller, was parsed, and was dropped. An officer opening
-- the application saw a permit type, a location and a stack of documents, and
-- none of what the applicant had actually typed.
alter table applications
  add column form jsonb not null default '{}'::jsonb,

  -- WHICH schema accepted it, or null for none.
  --
  -- Null is the honest state today: the unified DPWH/JMC forms have not been
  -- supplied (M-10), so no permit type has a field set to check against, and
  -- validating against one invented here would reject applications the LGU
  -- would have accepted.
  --
  -- Recording it as a column rather than assuming makes the gap queryable. When
  -- the real forms arrive, `where form_validated_against is null` is every
  -- application filed before there was anything to check — which is the
  -- question somebody will need answered, and cannot reconstruct afterwards.
  add column form_validated_against text;

comment on column applications.form is
  'pii:mixed:applicant-supplied — whatever the applicant typed into the permit wizard. '
  'Structurally bounded on the way in; semantically unchecked until M-10 supplies the forms.';

comment on column applications.form_validated_against is
  'The form schema version that accepted this, or NULL if none existed when it was filed.';

-- Finding the unvalidated ones later, without scanning every application.
create index applications_form_unvalidated on applications (submitted_at)
  where form_validated_against is null;
