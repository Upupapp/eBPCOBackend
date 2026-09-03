-- Reversal for 036_applicant_address.sql.
--
-- LOSSY, and unusually so. Every address here was typed by a citizen and
-- exists nowhere else in this service: `applications.location` is the site,
-- `businesses.street` is a business. Dropping these columns destroys the only
-- record of where the office can write to an applicant, and it cannot be
-- recovered from anything.

begin;

alter table applicants
  drop column middle_name,
  drop column street,
  drop column barangay,
  drop column city,
  drop column province,
  drop column postal_code;

delete from schema_migrations where version = 36;

commit;
