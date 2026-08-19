-- Idempotency, and the fee schedule the LGU publishes.

-- Every operation that creates a record or moves money carries a client-generated
-- key, created once when the operation is first attempted and reused on every
-- retry. The case that matters is a permit application or a payment whose
-- response was lost on a dropped mobile connection: replaying must return the
-- original result, not create a second one.
--
-- The response is stored, not just the fact of the key, because a retry needs
-- the same answer the first attempt produced. A key that only recorded "seen"
-- would turn a lost response into a 409 the client cannot act on.
create table idempotency_keys (
  key             uuid        not null,
  -- Scoped to the account, so one caller's key cannot collide with -- or be
  -- guessed into colliding with -- another's.
  account_id      uuid        not null references accounts (id) on delete cascade,
  operation       text        not null,
  request_digest  text        not null,
  response_status integer     not null,
  response_body   jsonb       not null,
  created_at      timestamptz not null default now(),
  primary key (account_id, key)
);

create index idempotency_keys_created_idx on idempotency_keys (created_at);

comment on column idempotency_keys.response_body is 'pii:mixed:snapshot — the stored response may echo applicant data; retained on the idempotency window, not longer';

-- The LGU's published fee schedule. Effective-dated, so a historical Order of
-- Payment can be explained against the schedule in force when it was made.
--
-- Ships EMPTY. This is M-08: the schedule is LGU-published material, and a
-- plausible-looking invented figure is worse than none — an applicant would be
-- quoted a fee the LGU never set and would have no way to know.
create table fee_schedules (
  version         text        primary key,
  effective_from  date        not null,
  effective_to    date,
  published_by    text,
  created_at      timestamptz not null default now(),

  constraint fee_schedule_range check (effective_to is null or effective_to > effective_from)
);

create table fee_schedule_entries (
  version          text    not null references fee_schedules (version) on delete cascade,
  permit_type      text    not null references permit_types (permit_type),
  line             text    not null check (line in
                     ('filing', 'processing', 'architectural', 'structural', 'electrical', 'others')),
  amount_centavos  numeric not null check (amount_centavos >= 0 and scale(amount_centavos) = 0),
  -- The ordinance, section or issuance this line rests on. An applicant handed
  -- a figure with no authority behind it has no way to question it, and RA
  -- 11032's transparency requirement is not satisfied by a total.
  basis            text    not null check (length(trim(basis)) > 0),
  primary key (version, permit_type, line)
);

-- A payment may be rejected and resubmitted, so an application can carry
-- several attempts. Only one may be verified.
create unique index payments_one_verified_idx
  on payments (application_id) where verified_at is not null;
