import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../domain/application';
import { EditableFields, RecordsService } from './records.service';

/**
 * Correcting a filed record — and, since the draft-saving feature, a
 * walk-in's still-unfiled one too. `edit()` had no unit coverage before
 * this file: everything here that is not about the renewal-reference
 * extension is baseline coverage for behaviour that already existed.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T06:00:00Z');

let db: SqlClient;
let records: RecordsService;

const OFFICER_ACCOUNT = randomUUID();
const APPLICANT_ACCOUNT = randomUUID();
let applicantId: string;

const officer: Caller = { accountId: OFFICER_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES['administrator'] };

async function file(options: {
  status?: 'Draft' | 'Submitted';
  permitType?: string;
  applicationAction?: 'New' | 'Renewal' | 'Amendment';
  renewsPermitId?: string | null;
  priorPermitClaim?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by, renews_permit_id, prior_permit_claim)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id, `BP-${id.slice(0, 8)}`, applicantId, options.permitType ?? 'Fencing Permit',
      options.applicationAction ?? 'New', options.status ?? 'Submitted',
      options.status === 'Draft' ? null : NOW.toISOString(), OFFICER_ACCOUNT,
      options.renewsPermitId ?? null, options.priorPermitClaim ?? null,
    ],
  );
  return id;
}

async function issuedPermit(): Promise<{ applicationId: string; permitNumber: string }> {
  const applicationId = await file({ status: 'Submitted' });
  const permitNumber = `BP-2020-${applicationId.slice(0, 6)}`;
  await db.query(
    `insert into generated_permits (application_id, permit_number, issued_date, generated_by)
     values ($1,$2,$3,$4)`,
    [applicationId, permitNumber, '2020-01-01', OFFICER_ACCOUNT],
  );
  return { applicationId, permitNumber };
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  records = new RecordsService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff','officer@lgu.gov.ph','officer@lgu.gov.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [OFFICER_ACCOUNT, APPLICANT_ACCOUNT],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

describe('what edit() already guaranteed', () => {
  it('refuses an empty patch', async () => {
    const id = await file({});
    const result = await records.edit({ applicationId: id, patch: {}, caller: officer });
    expect(result).toEqual({ ok: false, reason: 'empty-patch', detail: expect.any(String) });
  });

  it('refuses an application that does not exist', async () => {
    const result = await records.edit({
      applicationId: randomUUID(), patch: { location: 'New' }, caller: officer,
    });
    expect(result).toEqual({ ok: false, reason: 'not-found', detail: expect.any(String) });
  });

  it('writes only the named field and reports it changed', async () => {
    const id = await file({});
    const result = await records.edit({
      applicationId: id, patch: { location: 'Purok 3, Barangay Uno' }, caller: officer,
    });

    expect(result).toEqual({ ok: true, changed: ['location'] });
    const row = await db.query<{ location: string; updated_by: string }>(
      'select location, updated_by from applications where id = $1', [id],
    );
    expect(row.rows[0]).toEqual({ location: 'Purok 3, Barangay Uno', updated_by: OFFICER_ACCOUNT });
  });

  it('reports no change when the patch resends the current value', async () => {
    const id = await file({ permitType: 'Fencing Permit' });
    const result = await records.edit({
      applicationId: id, patch: { permitType: 'Fencing Permit' }, caller: officer,
    });
    expect(result).toEqual({ ok: true, changed: [] });
  });

  it('refuses once a permit has been generated', async () => {
    const { applicationId } = await issuedPermit();
    const result = await records.edit({
      applicationId, patch: { location: 'New' }, caller: officer,
    });
    expect(result).toEqual({ ok: false, reason: 'permit-generated', detail: expect.any(String) });
  });

  it('refuses a terminal application', async () => {
    // Cancelled, not Rejected: `enforce_lifecycle_transition` (the DB
    // trigger) enforces the transition table on this raw UPDATE too, and
    // Submitted -> Rejected is not a direct legal move. Submitted ->
    // Cancelled is, and Cancelled is just as terminal for this test's
    // purpose.
    const id = await file({});
    await db.query(`update applications set lifecycle_status = 'Cancelled' where id = $1`, [id]);
    const result = await records.edit({ applicationId: id, patch: { location: 'New' }, caller: officer });
    expect(result).toEqual({ ok: false, reason: 'terminal', detail: expect.any(String) });
  });

  it('freezes permitType/applicationAction/businessId once an order of payment exists', async () => {
    const id = await file({});
    await db.query(
      `insert into orders_of_payment (id, application_id, number, assessed_at, assessed_by, fee_schedule_version,
                                      filing_centavos, processing_centavos, architectural_centavos,
                                      structural_centavos, electrical_centavos, others_centavos, total_centavos)
       values ($1,$2,'OOP-1',$3,$4,'2026.1',0,0,0,0,0,0,0)`,
      [randomUUID(), id, NOW, OFFICER_ACCOUNT],
    );

    const result = await records.edit({
      applicationId: id, patch: { permitType: 'Demolition Permit' }, caller: officer,
    });
    expect(result).toEqual({ ok: false, reason: 'assessed', detail: expect.any(String) });

    // location stays correctable regardless -- it changes no computation.
    const stillEditable = await records.edit({
      applicationId: id, patch: { location: 'Corrected address' }, caller: officer,
    });
    expect(stillEditable.ok).toBe(true);
  });
});

describe('the renewal reference', () => {
  it('refuses renewsPermitNumber given without applicationAction', async () => {
    const id = await file({});
    const result = await records.edit({
      applicationId: id, patch: { renewsPermitNumber: 'BP-2020-000001' } as EditableFields, caller: officer,
    });
    expect(result).toEqual({ ok: false, reason: 'renewal-reference-incomplete', detail: expect.any(String) });
  });

  it('refuses priorPermitClaim given without applicationAction', async () => {
    const id = await file({});
    const result = await records.edit({
      applicationId: id, patch: { priorPermitClaim: 'BP-1998-000042' } as EditableFields, caller: officer,
    });
    expect(result).toEqual({ ok: false, reason: 'renewal-reference-incomplete', detail: expect.any(String) });
  });

  it('resolves and writes a permit already on file', async () => {
    const { permitNumber } = await issuedPermit();
    const id = await file({ applicationAction: 'New' });

    const result = await records.edit({
      applicationId: id,
      patch: { applicationAction: 'Renewal', renewsPermitNumber: permitNumber },
      caller: officer,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toEqual(expect.arrayContaining(['renewsPermitNumber', 'priorPermitClaim']));
    const row = await db.query<{ renews_permit_id: string | null; prior_permit_claim: string | null }>(
      'select renews_permit_id, prior_permit_claim from applications where id = $1', [id],
    );
    expect(row.rows[0]?.renews_permit_id).not.toBeNull();
    expect(row.rows[0]?.prior_permit_claim).toBeNull();
  });

  it('writes a prior-permit claim as-is, unresolved', async () => {
    const id = await file({ applicationAction: 'New' });

    const result = await records.edit({
      applicationId: id,
      patch: { applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' },
      caller: officer,
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ prior_permit_claim: string | null }>(
      'select prior_permit_claim from applications where id = $1', [id],
    );
    expect(row.rows[0]?.prior_permit_claim).toBe('BP-1998-000042');
  });

  it('refuses a permit number not on file, the same way a fresh filing would', async () => {
    const id = await file({ applicationAction: 'New' });

    const result = await records.edit({
      applicationId: id,
      patch: { applicationAction: 'Renewal', renewsPermitNumber: 'BP-9999-000001' },
      caller: officer,
    });

    expect(result).toEqual({ ok: false, reason: 'permit-not-found', detail: expect.any(String) });
  });

  it('refuses a FILED Renewal left naming no reference at all', async () => {
    // Not a Draft: a correction may not un-name what a real filing must name.
    const id = await file({ applicationAction: 'New' });

    const result = await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal' }, caller: officer,
    });

    expect(result).toEqual({ ok: false, reason: 'renewal-needs-a-permit', detail: expect.any(String) });
  });

  it('tolerates a Draft left naming no reference yet', async () => {
    const id = await file({ status: 'Draft', applicationAction: 'New' });

    const result = await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal' }, caller: officer,
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ application_action: string }>(
      'select application_action from applications where id = $1', [id],
    );
    expect(row.rows[0]?.application_action).toBe('Renewal');
  });

  it('reports no change when the same resolved reference is resent', async () => {
    const { permitNumber } = await issuedPermit();
    const id = await file({ applicationAction: 'New' });
    await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal', renewsPermitNumber: permitNumber }, caller: officer,
    });

    const replay = await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal', renewsPermitNumber: permitNumber }, caller: officer,
    });

    expect(replay).toEqual({ ok: true, changed: [] });
  });

  it('re-snapshots required_documents on a Draft when applicationAction changes', async () => {
    // Migration 053 seeded prior-permit-proof onto Renewal/Amendment's
    // checklist but not New's, for every permit type -- the same observable
    // difference submission.spec.ts proves updateDraft() with.
    const id = await file({ status: 'Draft', applicationAction: 'New' });

    await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' },
      caller: officer,
    });

    const row = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [id],
    );
    expect(row.rows[0]?.required_documents.some((d) => d.code === 'prior-permit-proof')).toBe(true);
  });

  it('leaves a FILED application\'s checklist frozen, even when applicationAction changes', async () => {
    // The one behaviour this class exists to guarantee for a real filing —
    // see this file's own doc comment. Confirmed unchanged by the extension.
    const id = await file({ status: 'Submitted', applicationAction: 'New' });
    const before = await db.query<{ required_documents: unknown }>(
      'select required_documents from applications where id = $1', [id],
    );

    await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' },
      caller: officer,
    });

    const after = await db.query<{ required_documents: unknown }>(
      'select required_documents from applications where id = $1', [id],
    );
    expect(after.rows[0]?.required_documents).toEqual(before.rows[0]?.required_documents);
  });

  it('records a before/after audit entry for the renewal reference', async () => {
    const { permitNumber } = await issuedPermit();
    const id = await file({ applicationAction: 'New' });

    await records.edit({
      applicationId: id, patch: { applicationAction: 'Renewal', renewsPermitNumber: permitNumber }, caller: officer,
    });

    const audit = await db.query<{ before_state: Record<string, unknown>; after_state: Record<string, unknown> }>(
      `select before_state, after_state from audit_events
        where action = 'application.edited' and subject_id = $1`,
      [id],
    );
    expect(audit.rows[0]?.before_state).toMatchObject({ renewsPermitId: null, priorPermitClaim: null });
    expect(audit.rows[0]?.after_state.renewsPermitId).not.toBeNull();
  });
});
