-- Documents, Orders of Payment, and payments.

create table documents (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        references applications (id) on delete restrict,
  uploaded_by     uuid        not null references accounts (id) on delete restrict,

  label           text        not null,
  file_name       text        not null,
  -- What magic-byte inspection found, never what the client claimed.
  content_type    text        not null,
  byte_size       bigint      not null check (byte_size > 0),
  -- Recorded at upload, verified on retrieval. RA 8792 treats an electronic
  -- document as evidence, and evidence whose alteration cannot be detected is
  -- not much use.
  sha256          text        not null check (sha256 ~ '^[a-f0-9]{64}$'),

  -- The object key. Opaque and non-enumerable; the bytes live in the object
  -- store, never here.
  storage_key     text        not null unique,

  status          text        not null default 'Pending'
                    check (status in ('Approved', 'Rejected', 'Missing', 'Pending')),
  -- False until malware scanning completes. While false the bytes are not
  -- retrievable by anyone, including the officer who would open them.
  scan_cleared    boolean     not null default false,
  scanned_at      timestamptz,

  expires_on      date,
  uploaded_at     timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on column documents.file_name   is 'pii:document:filename — applicants routinely name files after themselves';
comment on column documents.storage_key is 'reference:object-store — the document itself is personal data; this locates it';

-- An uncleared document must never be marked Approved: that would let an
-- officer approve a file nobody has scanned.
alter table documents add constraint approved_requires_scan
  check (status <> 'Approved' or scan_cleared);

create index documents_application_idx on documents (application_id) where deleted_at is null;
create index documents_unscanned_idx   on documents (uploaded_at) where not scan_cleared;

-- ── Money ────────────────────────────────────────────────────────────────
--
-- The Order of Payment is the sole authoritative source of an amount owed.
--
-- Every monetary column is NUMERIC with `scale(v) = 0`, not BIGINT, and the
-- reason is worth stating because BIGINT is the conventional choice.
--
-- PostgreSQL does not REJECT a non-integer written to a BIGINT column -- it
-- ROUNDS it. `insert into t (bigint_col) values (50000.75)` stores 50001, with
-- no error, and any CHECK constraint then runs against the already-rounded
-- value and passes. A fee of PHP 500.0075 silently becomes PHP 500.01. That was
-- found by a test written to prove the opposite, and it is exactly the failure
-- the "money is integer centavos" rule exists to prevent.
--
-- NUMERIC is exact decimal, not floating point, so it honours that rule; the
-- `scale(v) = 0` check then makes a non-integer a loud constraint violation
-- rather than a quiet correction. REAL and DOUBLE PRECISION remain banned
-- everywhere. The cost is marginally slower arithmetic and larger storage,
-- which at the volume of one LGU's permit fees is not a consideration.

create table orders_of_payment (
  id                      uuid        primary key default gen_random_uuid(),
  application_id          uuid        not null references applications (id) on delete restrict,
  number                  text        not null unique,

  filing_centavos         numeric      not null check (filing_centavos >= 0 and scale(filing_centavos) = 0),
  processing_centavos     numeric      not null check (processing_centavos >= 0 and scale(processing_centavos) = 0),
  architectural_centavos  numeric      not null check (architectural_centavos >= 0 and scale(architectural_centavos) = 0),
  structural_centavos     numeric      not null check (structural_centavos >= 0 and scale(structural_centavos) = 0),
  electrical_centavos     numeric      not null check (electrical_centavos >= 0 and scale(electrical_centavos) = 0),
  others_centavos         numeric      not null check (others_centavos >= 0 and scale(others_centavos) = 0),

  -- Stored AND constrained to equal the sum of its own lines. Storing a total
  -- that could disagree with its components is how a figure at the cashier
  -- stops matching the figure on the screen; the constraint makes the two the
  -- same fact rather than two facts that happen to agree.
  total_centavos          numeric      not null check (total_centavos >= 0 and scale(total_centavos) = 0),
  constraint total_equals_its_lines check (
    total_centavos = filing_centavos + processing_centavos + architectural_centavos
                   + structural_centavos + electrical_centavos + others_centavos
  ),

  -- Which published schedule this was computed under, so a historical
  -- assessment can always be explained.
  fee_schedule_version    text        not null,

  assessed_at             timestamptz not null default now(),
  assessed_by             uuid        not null references accounts (id) on delete restrict,
  due_date                date,

  -- A correction is a NEW order superseding the old one, never an edit.
  supersedes_id           uuid        references orders_of_payment (id),
  superseded_reason       text,
  superseded_at           timestamptz,

  constraint supersede_has_a_reason check (
    (supersedes_id is null and superseded_reason is null)
    or (supersedes_id is not null and superseded_reason is not null)
  )
);

create index orders_of_payment_application_idx on orders_of_payment (application_id);
-- At most one order in force per application at a time.
create unique index orders_of_payment_in_force_idx
  on orders_of_payment (application_id) where superseded_at is null;

-- An issued Order of Payment is immutable. Amending one after an applicant has
-- been told what to pay is indistinguishable, from their side, from being
-- charged a different amount than they were quoted.
create or replace function reject_order_amendment() returns trigger as $$
begin
  if new.filing_centavos        is distinct from old.filing_centavos
  or new.processing_centavos    is distinct from old.processing_centavos
  or new.architectural_centavos is distinct from old.architectural_centavos
  or new.structural_centavos    is distinct from old.structural_centavos
  or new.electrical_centavos    is distinct from old.electrical_centavos
  or new.others_centavos        is distinct from old.others_centavos
  or new.total_centavos         is distinct from old.total_centavos
  or new.number                 is distinct from old.number then
    raise exception 'an issued Order of Payment is immutable; supersede it with a new one'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger orders_of_payment_immutable
  before update on orders_of_payment
  for each row execute function reject_order_amendment();

-- A payment cannot exist without the Order it settles. NOT NULL on the foreign
-- key, so this is unrepresentable rather than merely refused by the service.
create table payments (
  id                        uuid        primary key default gen_random_uuid(),
  order_of_payment_id       uuid        not null references orders_of_payment (id) on delete restrict,
  application_id            uuid        not null references applications (id) on delete restrict,

  reference_number          text        not null,
  amount_centavos           numeric     not null check (amount_centavos > 0 and scale(amount_centavos) = 0),
  method                    text        not null check (method in ('Bank Transfer', 'Onsite')),

  status                    text        not null default 'Pending Verification'
                              check (status in ('Not Yet Available', 'Pending Verification', 'Paid', 'Overdue')),

  proof_document_id         uuid        references documents (id) on delete restrict,
  submitted_at              timestamptz not null default now(),
  submitted_by              uuid        not null references accounts (id) on delete restrict,

  -- Only an officer's verification reaches Paid. A client must never be able to
  -- declare itself paid, so the two fields move together or not at all.
  verified_at               timestamptz,
  verified_by               uuid        references accounts (id) on delete restrict,
  official_receipt_number   text,

  constraint verification_is_attributable check (
    (verified_at is null and verified_by is null)
    or (verified_at is not null and verified_by is not null)
  ),
  constraint paid_requires_verification check (
    status <> 'Paid' or (verified_at is not null and official_receipt_number is not null)
  ),
  -- The officer who assessed a fee must not also be the one who confirms it was
  -- paid. Separation of duty, in the schema rather than in a policy document.
  constraint verifier_is_not_the_submitter check (verified_by is distinct from submitted_by)
);

create index payments_application_idx on payments (application_id);
create index payments_order_idx       on payments (order_of_payment_id);
create index payments_unverified_idx  on payments (submitted_at) where verified_at is null;
