-- The assessment an officer BUILDS, before the Order of Payment an applicant is
-- handed.
--
-- Until now the two were one act: `issue()` read the published schedule,
-- computed six figures and wrote an Order, all under one officer's authority
-- and with no second signature anywhere. That is the control weakness this
-- table exists to close. The officer who assesses a fee must not be the one who
-- approves it, for the same reason the officer who records a payment may not
-- confirm it — and the same reason an evaluator may not evaluate their own
-- application.
--
-- Separate from `orders_of_payment` rather than a status column on it. An Order
-- is the ISSUED instrument: it carries a unique number, it is what the cashier
-- and the applicant both read, and it is superseded rather than edited. A draft
-- has no number, changes repeatedly, and may never be issued at all. Putting
-- both in one table would mean a nullable number on the thing whose number is
-- its identity.
create table assessments (
  id                    uuid        primary key default gen_random_uuid(),
  application_id        uuid        not null references applications (id) on delete restrict,

  status                text        not null default 'Draft'
                          check (status in ('Draft', 'Submitted', 'Approved', 'Issued', 'Withdrawn')),

  -- Which published schedule the figures were computed under, captured when the
  -- draft is opened. A schedule that changes mid-draft must not silently move
  -- the numbers an officer has already reviewed.
  fee_schedule_version  text        not null,
  due_date              date,

  created_by            uuid        not null references accounts (id) on delete restrict,
  created_at            timestamptz not null default now(),
  submitted_by          uuid        references accounts (id) on delete restrict,
  submitted_at          timestamptz,
  approved_by           uuid        references accounts (id) on delete restrict,
  approved_at           timestamptz,
  order_of_payment_id   uuid        references orders_of_payment (id),
  updated_at            timestamptz not null default now(),

  -- SEPARATION OF DUTY, IN THE DATABASE. Enforced here rather than only in the
  -- service because a bug that has to defeat a constraint is a much harder bug
  -- to write than one that has to defeat an `if` — the same reasoning that put
  -- "an applicant may never hold a staff role" in a trigger.
  constraint approver_is_not_the_assessor check (
    approved_by is null or (approved_by <> created_by and approved_by <> submitted_by)
  ),
  -- Nothing is approved that was never submitted for approval.
  constraint approval_follows_submission check (
    approved_by is null or submitted_by is not null
  ),
  constraint approved_has_a_time check ((approved_by is null) = (approved_at is null)),
  constraint submitted_has_a_time check ((submitted_by is null) = (submitted_at is null))
);

-- One open assessment per application. Two officers drafting different figures
-- for the same permit is how an applicant is handed two bills.
create unique index one_open_assessment_per_application
  on assessments (application_id)
  where status in ('Draft', 'Submitted', 'Approved');

-- The six lines, which are the admin's own `AssessmentFeeCentavos` and the same
-- six an Order of Payment carries. Not arbitrary rows: the instrument they
-- become has six fixed columns, so a seventh line would have nowhere to go.
create table assessment_lines (
  assessment_id      uuid    not null references assessments (id) on delete cascade,
  line               text    not null check (line in
                       ('filing', 'processing', 'architectural', 'structural', 'electrical', 'others')),

  -- What the SCHEDULE said, kept beside what the officer set. An override is a
  -- fact worth recording: "the officer charged less than the ordinance
  -- prescribes" is a question an auditor will eventually ask, and it cannot be
  -- answered from the final figure alone.
  computed_centavos  numeric not null check (computed_centavos >= 0 and scale(computed_centavos) = 0),
  amount_centavos    numeric not null check (amount_centavos >= 0 and scale(amount_centavos) = 0),

  -- The ordinance or issuance the line rests on. A non-zero charge with no
  -- stated authority is a figure the applicant cannot question, which is the
  -- rule `buildLineItems` already enforces at issue time.
  basis              text    not null default '',
  included           boolean not null default true,

  primary key (assessment_id, line),
  constraint charged_lines_state_their_authority check (
    included = false or amount_centavos = 0 or length(trim(basis)) > 0
  )
);

-- Which assessment an Order was issued from. Null for every Order issued before
-- this table existed, which is why it is nullable rather than back-filled with
-- a guess.
alter table orders_of_payment add column assessment_id uuid references assessments (id);
