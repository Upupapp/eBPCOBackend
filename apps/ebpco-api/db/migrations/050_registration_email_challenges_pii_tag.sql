-- Migration 048 (registration_email_challenges) shipped without the pii:
-- comment every other personal-data column in this schema carries --
-- caught by personal-data-inventory.spec.ts's own gap-detection test, which
-- scans information_schema for column names that look like personal data
-- (this repo's db/migrations/committing convention won't let 048 itself be
-- edited after the fact: schema_migrations tracks each file's checksum, and
-- an already-migrated database -- Linode's included -- would fail on a
-- changed file it had already applied).
--
-- `email` here identifies the person attempting to register, before any
-- account exists — the same reasoning applicants.first_name/etc. get in
-- migration 003, applied to a table keyed by email instead of account_id.
comment on column registration_email_challenges.email is
  'pii:identity:email — lawful basis: performance of a public task (verifying a citizen''s email before account creation)';
