-- 044_fee_schedule_seed.sql
--
-- `fee_schedules`/`fee_schedule_entries` have existed since their own
-- migration and have never had a single row in either table, on ANY
-- database this backend has ever run against -- confirmed empty on the
-- fresh Linode deployment (0 rows in both), and no earlier migration
-- contains an `insert into fee_schedule`. `assessment-workflow.service.ts`
-- correctly refuses to start an assessment when no schedule is in force on
-- the filing date ("No LGU fee schedule is in force on this date, so
-- nothing can be assessed") -- there was simply never a schedule published
-- for it to find, for any permit type, including Fencing.
--
-- Same shape as 043's document-requirements gap: a reference table the
-- application logic has always correctly read from, that nothing ever
-- wrote to.
--
-- ── What these amounts are, and are not ────────────────────────────────
--
-- A flat filing fee (PHP 500.00) and processing fee (PHP 1,200.00) for
-- every permit type, plus Fencing Permit's own additional structural fee
-- (PHP 5,120.00), cited to "City Ordinance 2026-004 s.3" as `basis`. This is
-- a functional placeholder, not a transcription of the Municipality's actual
-- per-type fee structure the way 043's document checklist was transcribed
-- from a real, cited source -- no such source exists yet in this codebase.
-- It exists so the Payment Assessment screen can be exercised end-to-end
-- (Start Assessment -> compute an order of payment -> pay -> release) rather
-- than refusing outright for lack of any schedule at all. Confirm the real
-- per-type amounts with the Municipal Treasurer's Office before production
-- launch and publish a superseding version -- `effective_from`/`effective_to`
-- make that a new row, never an edit of this one.
begin;

insert into fee_schedules (version, effective_from, effective_to, published_by) values
  ('2026.1', '2026-01-01', null, 'City Ordinance 2026-004');

insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis) values
  ('2026.1', 'Architectural Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Architectural Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – Addition / Extension', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – Addition / Extension', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – New Construction', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – New Construction', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – Renovation / Alteration', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Building Permit – Renovation / Alteration', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Business Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Business Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Certificate of Occupancy', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Certificate of Occupancy', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Civil / Structural Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Civil / Structural Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Demolition Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Demolition Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Electrical Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Electrical Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Electronics Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Electronics Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Excavation Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Excavation Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'FSEC for Building Permit (BFP)', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'FSEC for Building Permit (BFP)', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'FSIC for Occupancy Permit (BFP)', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'FSIC for Occupancy Permit (BFP)', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Fencing Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Fencing Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Fencing Permit', 'structural', 512000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Interior Design Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Interior Design Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Mechanical Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Mechanical Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Plumbing Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Plumbing Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Sanitary Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Sanitary Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Sign Permit', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Sign Permit', 'processing', 120000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Zoning / Locational Clearance', 'filing', 50000, 'City Ordinance 2026-004 s.3'),
  ('2026.1', 'Zoning / Locational Clearance', 'processing', 120000, 'City Ordinance 2026-004 s.3');

commit;
