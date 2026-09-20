-- Reversal for 050_registration_email_challenges_pii_tag.sql.
--
-- Lossless: a column comment carries no data of its own.

begin;

comment on column registration_email_challenges.email is null;

delete from schema_migrations where version = 50;

commit;
