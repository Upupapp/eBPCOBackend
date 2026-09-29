-- 060: which evaluation stage checks each required document -- and so which
-- stages an application goes through at all (owner request, 2026-09-29).
--
-- Until now every permit type went through all five stages. A Fencing Permit
-- waited on the Bureau of Fire Protection although nothing on its checklist is
-- the BFP's to check. Now each checklist entry names the stage that checks it,
-- and an application goes through:
--
--   Initial and Final Approval -- always;
--   Zoning, Fire Safety, OBO   -- only when a REQUIRED document on the
--                                  checklist it was filed against is checked
--                                  at that stage.
--
-- Read from the application's own checklist snapshot (`required_documents`,
-- 022), never from the live checklist, so editing a checklist does not move
-- an application already in evaluation. A snapshot taken before this
-- migration carries no stages and keeps all five: it was filed under that
-- rule.

alter table document_requirements
  add column stage text not null default 'Initial'
    check (stage in ('Initial', 'Zoning', 'Fire Safety', 'OBO'));

comment on column document_requirements.stage is
  'The evaluation stage that checks this document. Initial: identity, ownership and the application itself, checked for completeness at intake. Zoning: the MPDO''s (locational clearance, the zoning clearance package). Fire Safety: the BFP''s (FSEC, FSIC). OBO: the Building Official''s technical review (plans, licences, specifications). A stage with no required document on an application''s checklist is skipped for that application.';

-- ── Seeded from what each document is ──────────────────────────────────────
--
-- Zoning: the Locational Clearance the MPDO issues, and the whole package of
-- the Zoning / Locational Clearance itself.
update document_requirements set stage = 'Zoning'
 where code in ('locational', 'bpnc-zoning-locational') or code like 'zoning-%';

-- Fire Safety: what the BFP issues or reviews -- the FSEC for a building
-- permit, the FSIC for occupancy, and the packages of the two BFP permit types.
update document_requirements set stage = 'Fire Safety'
 where code in ('bpnc-fire-safety-clearance', 'coo-fsic')
    or code like 'fsec-%' or code like 'fsic-%';

-- OBO: every technical document -- plans, analyses, specifications, cost
-- estimates, licences of the professionals of record, completion and
-- inspection certificates. Everything not identity, ownership or the form.
update document_requirements set stage = 'OBO'
 where stage = 'Initial'
   and code not in (
     'land-title', 'owner-consent', 'brgy-clearance', 'valid-id', 'prior-permit-proof',
     'bpnc-oct-tct', 'bpnc-unified-form', 'bpnc-valid-id', 'renovation-existing-permit',
     'generic-valid-id', 'generic-brgy-clearance', 'generic-proof-address'
   );

-- ── An FSEC for every building permit ──────────────────────────────────────
--
-- The Fire Code (RA 9514) makes the FSEC a prerequisite of a building permit,
-- and JMC 2018-01 releases the two together -- for construction, renovation
-- or addition alike. The New checklist asked for it; Renewal (renovation /
-- alteration) and Amendment (addition / extension) did not.
update document_requirements set position = position + 1
 where permit_type = 'Building Permit' and application_action in ('Renewal', 'Amendment')
   and position >= 4
   and not exists (
     select 1 from document_requirements x
      where x.permit_type = 'Building Permit' and x.application_action = document_requirements.application_action
        and x.code = 'fsec');

insert into document_requirements (permit_type, application_action, code, label, description, required, position, stage)
select 'Building Permit', a.action, 'fsec', 'Fire Safety Evaluation Clearance (FSEC)',
       'Issued by the Bureau of Fire Protection, not by the Municipality. Apply online at BFP-FSIS (fsis.e-bfp.com) or at the Castilla Fire Station, then upload the FSEC you receive here.',
       true, 4, 'Fire Safety'
  from (values ('Renewal'), ('Amendment')) as a(action)
 where not exists (
   select 1 from document_requirements x
    where x.permit_type = 'Building Permit' and x.application_action = a.action and x.code = 'fsec');

-- ── Where each clearance comes from, said on the checklist ─────────────────
update document_requirements
   set description = 'Issued by the Bureau of Fire Protection, not by the Municipality. Apply online at BFP-FSIS (fsis.e-bfp.com) or at the Castilla Fire Station, then upload the FSEC you receive here.'
 where code = 'bpnc-fire-safety-clearance';

update document_requirements
   set description = 'Issued by the Bureau of Fire Protection after it inspects the finished building. Apply online at BFP-FSIS (fsis.e-bfp.com) or at the Castilla Fire Station, then upload the FSIC you receive here.'
 where code = 'coo-fsic';

update document_requirements
   set description = 'Issued by the Municipal Planning and Development Office. You can apply for it in eBPCO under Zoning / Locational Clearance.'
 where code in ('locational', 'bpnc-zoning-locational') and description = '';

-- ── The BFP's own permits are the BFP's ─────────────────────────────────────
--
-- The FSEC and the FSIC are issued by the BFP through its own system, BFP-FSIS
-- (BFP Memorandum Circular 2024-024, online since December 2024). Filing them
-- with the Municipality sent citizens to the wrong office. Retired, not
-- deleted: a retired type keeps its history and stops being offered.
update permit_types set retired_at = coalesce(retired_at, now())
 where permit_type in ('FSEC for Building Permit (BFP)', 'FSIC for Occupancy Permit (BFP)');

-- ── The stages an application goes through ─────────────────────────────────
--
-- One definition, used by the queue, the lifecycle's evaluations-complete
-- precondition and the evaluation service (evaluation-stages.ts mirrors it for
-- in-memory checks; the two are tested against each other).
create function application_evaluation_stages(checklist jsonb) returns text[]
language sql immutable as $$
  select case
    when checklist is null or jsonb_typeof(checklist) <> 'array'
      or not exists (
        select 1 from jsonb_array_elements(checklist) d
         where jsonb_typeof(d) = 'object' and d ? 'stage')
    then array['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval']
    else array(
      select s.stage
        from unnest(array['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'])
             with ordinality as s(stage, ord)
       where s.stage in ('Initial', 'Final Approval')
          or exists (
            select 1 from jsonb_array_elements(checklist) d
             where jsonb_typeof(d) = 'object' and d->>'stage' = s.stage
               and coalesce(d->>'required', 'true') <> 'false')
       order by s.ord)
  end
$$;

comment on function application_evaluation_stages(jsonb) is
  'The evaluation stages an application goes through, from its checklist snapshot: Initial and Final Approval always, Zoning / Fire Safety / OBO when a required document is checked there. A snapshot without stages (filed before 060) keeps all five.';
