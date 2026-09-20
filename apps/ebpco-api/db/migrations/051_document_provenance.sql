-- 051: where a document came from, and when it was issued.
--
-- The Admin Portal's walk-in intake has always asked the officer for each
-- attachment's Issuing Office, Issue Date and Expiry Date — and then sent
-- none of them, because nothing here could hold the first two. `expires_on`
-- (migration 004) existed and was never written by an upload either. A form
-- that collects what it cannot keep is a form that lies to the person
-- filling it in; this gives the two missing facts a home so the route can
-- accept all three.
--
-- Both nullable: the citizen's own wizard does not ask for them, and a plan
-- or a drawing has no issuing office in the sense a clearance does.
-- `issued_on` is a calendar date the document carries, like `expires_on` and
-- `certified_on` beside it — not an instant this service observed, hence
-- `date`, not `timestamptz`.

alter table documents
  add column issued_on      date,
  add column issuing_office text;

-- Consistency the form already implies: a document cannot expire before it
-- was issued. Nulls pass (a plan with neither).
alter table documents
  add constraint documents_expiry_after_issue
    check (issued_on is null or expires_on is null or expires_on >= issued_on);

comment on column documents.issued_on      is 'When the document was issued, as printed on it; null when the uploader did not say';
comment on column documents.issuing_office is 'Which office issued the document, as the uploader described it; null when not given';
