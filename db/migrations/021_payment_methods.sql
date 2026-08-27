-- Which payment methods the LGU is currently accepting.
--
-- The VOCABULARY stays in the check constraint on `payments.method`: 'Bank
-- Transfer' and 'Onsite' are the two the software knows how to handle, and a
-- third would need code, not a row. What was missing is AVAILABILITY — an LGU
-- whose bank arrangement lapses, or whose cashier's window is closed for the
-- week, has no way to stop offering a method short of a deploy.
--
-- So this table does not decide what a method IS, only whether it is being
-- offered today and what an applicant should be told about it.
create table payment_methods (
  method        text        primary key check (method in ('Bank Transfer', 'Onsite')),
  label         text        not null,
  active        boolean     not null default true,
  -- Shown to the applicant when they choose it: which account to transfer to,
  -- or which window to visit and when. Free text because it is the LGU's own
  -- notice, not a field the software reasons about.
  instructions  text        not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references accounts (id) on delete restrict
);

-- Seeded active, because that is what the system did before this table existed.
-- A migration that silently turned both off would stop every payment in flight.
insert into payment_methods (method, label) values
  ('Bank Transfer', 'Bank Transfer'),
  ('Onsite', 'Onsite (cashier)');
