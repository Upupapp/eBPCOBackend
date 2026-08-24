-- The RA 10173 §18 right to a portable copy of your own personal data.
--
-- Asynchronous, and a table rather than a response, for three reasons.
--
-- An export reads every application, document record, payment and notification
-- an applicant has. Doing that inside a request holds a connection for as long
-- as it takes and times out for exactly the people with the most data — who are
-- the ones most likely to be asking.
--
-- A request that fails needs to say so. An export that quietly produced nothing
-- is indistinguishable, from the applicant's side, from one the LGU ignored,
-- and RA 10173 gives them fifteen days to be answered.
--
-- And the file has to expire. A portable copy of somebody's entire permit
-- history sitting on indefinitely-signed storage is a standing disclosure; the
-- row is what makes the expiry checkable rather than remembered.
create table data_export_requests (
  id              uuid        primary key default gen_random_uuid(),
  account_id      uuid        not null references accounts (id) on delete cascade,

  status          text        not null default 'queued'
                    check (status in ('queued', 'ready', 'failed', 'expired')),

  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,

  -- Where the produced file lives, and what it is. Null until ready.
  storage_key     text,
  byte_size       bigint      check (byte_size is null or byte_size > 0),
  -- So the applicant can verify the file they downloaded is the file the LGU
  -- produced. A portable copy nobody can check the integrity of is a copy they
  -- have to take on trust.
  sha256          text        check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),

  -- After this the file is deleted and the row says 'expired'. Short by design:
  -- see the table comment.
  expires_at      timestamptz,

  -- Never the raw error. A failure message can carry a row from the query that
  -- failed, and this table is about one named person.
  failure_detail  text,

  constraint ready_export_is_downloadable check (
    status <> 'ready'
    or (storage_key is not null and byte_size is not null
        and sha256 is not null and expires_at is not null and completed_at is not null)
  ),

  constraint failed_export_says_why check (
    status <> 'failed' or failure_detail is not null
  )
);

comment on table data_export_requests is
  'RA 10173 s.18 portability requests. The produced file expires; see expires_at.';

comment on column data_export_requests.storage_key is
  'pii:mixed:snapshot — the object it points at contains the subject''s entire record. '
  'Deleted when the request expires.';

-- One outstanding request per account.
--
-- Not a rate limit dressed up: an export is expensive to produce and a second
-- one queued while the first is still running produces two identical files and
-- doubles the work for no benefit to anyone. A partial index, so a person may
-- request again once the first has finished.
create unique index one_outstanding_export_per_account
  on data_export_requests (account_id)
  where status = 'queued';

-- Finding what is due to be produced, and what is due to be swept.
create index data_export_requests_queued on data_export_requests (requested_at)
  where status = 'queued';
create index data_export_requests_expiring on data_export_requests (expires_at)
  where status = 'ready';

insert into scheduled_jobs (name, interval_seconds, enabled) values
  -- Every two minutes. An applicant exercising a statutory right should not
  -- wait an hour for a scheduler, and the work is bounded by the index above.
  ('data-export', 120, true),
  -- Daily. Deleting the produced files once they expire is the other half of
  -- the promise the expiry makes.
  ('data-export-expiry', 86400, true);
