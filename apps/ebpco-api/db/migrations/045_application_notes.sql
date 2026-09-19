-- Internal staff notes on an application — a workspace for the office to
-- leave each other context (e.g. an evaluator flagging something for the
-- assessor) that is neither a lifecycle transition nor an applicant-facing
-- remark. The Admin Portal's own "Comments" tab has shown this since it was
-- built, entirely local to one browser tab: nothing an officer typed there
-- was ever sent anywhere, so it vanished on reload and was never visible to
-- a second officer on the same file.
--
-- `depth` is stored rather than derived from `parent_note_id` at read time —
-- the portal's own reply UI already caps a thread at three levels
-- (0/1/2, `Math.min(target.depth + 1, 2)`), and storing what the client
-- already decided avoids a recursive query for every list.

begin;

create table application_notes (
  id                uuid        primary key default gen_random_uuid(),
  application_id    uuid        not null references applications (id) on delete restrict,
  author_account_id uuid        not null references accounts (id) on delete restrict,
  parent_note_id    uuid        references application_notes (id) on delete restrict,
  depth             smallint    not null default 0 check (depth between 0 and 2),
  body              text        not null check (char_length(body) between 1 and 4000),
  created_at        timestamptz not null default now()
);

create index application_notes_app_idx on application_notes (application_id, created_at);

commit;
