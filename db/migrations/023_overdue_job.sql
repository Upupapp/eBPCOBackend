-- The overdue sweep, registered so the runner will run it.
--
-- A job the code defines but this table does not know about is refused with
-- `unknown-job` — deliberately, because a scheduler that runs whatever a
-- deployment happens to contain is one nobody can turn off. It also means
-- adding a job is two changes, and forgetting the second produces a job that
-- silently never runs.
--
-- Every six hours. A due date is a date, not a moment: an applicant whose
-- payment fell due at midnight is not owed a notice at 00:01, and sweeping
-- more often only means finding nothing more often. Six hours also means a
-- transient failure is retried the same day rather than a day later.
insert into scheduled_jobs (name, interval_seconds, enabled) values
  ('overdue-assessments', 21600, true);
