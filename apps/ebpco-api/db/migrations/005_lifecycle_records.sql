-- The records the lifecycle produces: evaluations, Letters of Instruction,
-- inspections, generated permits, and releases.

create table evaluations (
  id               uuid        primary key default gen_random_uuid(),
  application_id   uuid        not null references applications (id) on delete restrict,
  stage            text        not null check (stage in ('Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval')),
  result           text        not null default 'Pending'
                     check (result in ('Pending', 'Passed', 'Revision Required', 'Rejected')),
  evaluator_id     uuid        references accounts (id) on delete restrict,
  -- Verbatim, always. Never summarised, never truncated: the applicant is being
  -- told what to fix, and a paraphrase of "sheet S-3 is unsigned" is not
  -- actionable.
  remarks          text,
  evaluated_at     timestamptz,

  unique (application_id, stage),

  -- A result that sends work back to the applicant must say why. An
  -- unexplained "Revision Required" is a deadline the applicant cannot meet
  -- because they do not know what to do.
  constraint adverse_result_has_remarks check (
    result not in ('Revision Required', 'Rejected') or (remarks is not null and length(trim(remarks)) > 0)
  ),
  constraint decided_evaluation_is_attributable check (
    result = 'Pending' or (evaluator_id is not null and evaluated_at is not null)
  )
);

create index evaluations_application_idx on evaluations (application_id);

create table letters_of_instruction (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references applications (id) on delete restrict,
  issued_at       timestamptz not null default now(),
  issued_by       uuid        not null references accounts (id) on delete restrict,
  closed_at       timestamptz
);

create table instruction_items (
  id            uuid        primary key default gen_random_uuid(),
  letter_id     uuid        not null references letters_of_instruction (id) on delete cascade,
  subject       text        not null,
  remark        text        not null check (length(trim(remark)) > 0),
  resolved_at   timestamptz,
  -- What the applicant sent back to close it.
  response      text,
  response_document_id uuid  references documents (id) on delete restrict
);

create index instruction_items_letter_idx on instruction_items (letter_id);
-- The count an applicant sees on the home screen, and the badge on the tab.
create index instruction_items_open_idx on instruction_items (letter_id) where resolved_at is null;

create table inspections (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references applications (id) on delete restrict,
  scheduled_at    timestamptz not null,
  offices         text[]      not null default '{}',
  checklist       text[]      not null default '{}',
  outcome         text,
  remarks         text,
  completed_at    timestamptz
);

create index inspections_application_idx on inspections (application_id);

create table generated_permits (
  application_id  uuid        primary key references applications (id) on delete restrict,
  permit_number   text        not null unique,
  issued_date     timestamptz not null,
  scope           text,
  conditions      text[]      not null default '{}',
  generated_by    uuid        not null references accounts (id) on delete restrict
);

create table permit_releases (
  application_id     uuid        primary key references applications (id) on delete restrict,
  status             text        not null default 'Not Ready'
                       check (status in ('Not Ready', 'Ready for Release', 'Released')),
  method             text        check (method in ('Physical Claim', 'Authorized Representative')),
  claimant_name      text,
  releasing_officer  uuid        references accounts (id) on delete restrict,
  released_at        timestamptz,

  -- LGU-specific (M-11 / decision E-15). Null rather than guessed: telling an
  -- applicant the wrong office hours wastes a trip they had to take.
  claim_location     text,
  office_hours       text,
  bring_with_you     text[]      not null default '{}',

  -- A permit cannot be released to nobody, at no time, by nobody.
  constraint release_is_attributable check (
    status <> 'Released'
    or (released_at is not null and releasing_officer is not null
        and claimant_name is not null and method is not null)
  )
);

comment on column permit_releases.claimant_name is 'pii:identity:name — who collected the permit, retained as proof of release';

-- A permit cannot be released before it has been generated.
create or replace function enforce_permit_exists_before_release() returns trigger as $$
begin
  if new.status = 'Released'
     and not exists (select 1 from generated_permits where application_id = new.application_id) then
    raise exception 'application % has no generated permit to release', new.application_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger permit_releases_require_permit
  before insert or update on permit_releases
  for each row execute function enforce_permit_exists_before_release();
