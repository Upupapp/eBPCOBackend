-- Periodic work, and the record of whether it happened.
--
-- Retention, audit-chain verification and notification dispatch were all
-- written, tested, and never run: nothing called them. A cron entry inside the
-- process is the obvious fix and the wrong one, because the process runs N
-- times. Three replicas means retention deletes concurrently, the chain is
-- verified three times a night, and a notification is planned by whichever
-- replica gets there first -- or by all of them.
--
-- So a job is CLAIMED before it runs. The claim is one UPDATE with a WHERE that
-- only matches an unheld lock, which PostgreSQL serialises on the row: exactly
-- one replica gets the row back, and the others get nothing and move on. No
-- leader election, no external coordinator, no extra dependency to be down.
--
-- The table earns its place twice over. The second reason is operational: "did
-- retention run last night?" is a question somebody asks at 9am after a
-- complaint, and an advisory lock cannot answer it.
create table scheduled_jobs (
  name              text        primary key,

  -- How often it should run. Not a cron expression: this service needs "every
  -- N seconds" and nothing more, and a cron parser is a dependency and a class
  -- of bug in exchange for expressiveness nobody has asked for.
  interval_seconds  integer     not null check (interval_seconds > 0),

  enabled           boolean     not null default true,

  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_outcome      text        check (last_outcome in ('succeeded', 'failed')),
  -- Truncated, and never the full error: a job failure message can carry a row
  -- from the query that failed, and this table is read by anyone with database
  -- access rather than by the audit trail's rules.
  last_detail       text,

  -- Reset on success. A job failing once is noise; a job that has failed nine
  -- times in a row is an outage nobody has noticed.
  consecutive_failures integer  not null default 0 check (consecutive_failures >= 0),

  -- Who holds it, and until when. `locked_until` rather than a boolean, so a
  -- replica that is SIGKILLed mid-job does not hold the lock for ever -- the
  -- claim expires and the next tick picks it up. That is also why every job has
  -- to be safe to run twice: the expiry cannot tell a dead replica from a slow
  -- one.
  locked_by         text,
  locked_until      timestamptz,

  constraint lock_is_whole check ((locked_by is null) = (locked_until is null))
);

comment on table scheduled_jobs is
  'Periodic work, claimed by exactly one replica at a time. Also the answer to '
  '"did it run?", which an advisory lock cannot give.';

-- Seeded here rather than by the application on boot. A job row created at
-- startup is a job that silently stops existing when someone renames it in
-- code, and the first anyone knows is that retention has not run for a month.
insert into scheduled_jobs (name, interval_seconds, enabled) values
  -- Hourly. Retention is not urgent, and running it often keeps each run small
  -- enough that a failure loses little progress.
  ('document-retention', 3600, true),

  -- Daily. Verifying the chain reads every audit row, so it is deliberately
  -- infrequent -- and a tamper-evident log nobody checks is just a log.
  ('audit-chain-verification', 86400, true),

  -- Every minute. An applicant waiting on "your permit is ready" should not
  -- wait an hour for a scheduler.
  ('notification-dispatch', 60, true),

  -- Daily. Idempotency keys, expired refresh tokens and used password-reset
  -- tickets are erased with an account; they accumulate for accounts that are
  -- never erased.
  ('operational-data-purge', 86400, true);
