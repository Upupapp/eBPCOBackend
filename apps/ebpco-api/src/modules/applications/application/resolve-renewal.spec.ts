import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES } from '../../identity/domain/account';
import { CalendarRepository } from '../../compliance/application/calendar.repository';
import { Caller } from '../domain/application';
import { ApplicantQueryService } from './applicant-query.service';
import { resolveRenewal } from './resolve-renewal';
import { Submission, SubmissionService } from './submission.service';

/**
 * Which permit a Renewal or Amendment is about — theirs, for this business,
 * of this permit type, or refused.
 *
 * The bug this exists for: a citizen could type anything into "Existing
 * Permit Number" and carry on, because the only check was that the permit
 * was the applicant's own. A real permit of theirs issued to a DIFFERENT
 * business, or of a different permit type, sailed through too — linking the
 * officer to the wrong original.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T06:00:00Z');

let db: SqlClient;
let submissions: SubmissionService;
let queries: ApplicantQueryService;

const MARIA = randomUUID();
const JOSE = randomUUID();
const OFFICIAL = randomUUID();
let mariaApplicant: string;
let joseApplicant: string;
let bakery: string;
let hardware: string;

const maria: Caller = { accountId: MARIA, kind: 'applicant', scopes: APPLICANT_SCOPES };

const submission = (overrides: Partial<Submission> = {}): Submission => ({
  permitType: 'Building Permit',
  applicationAction: 'New',
  businessId: null,
  location: '12 Rizal Street, Poblacion Uno',
  documentIds: [],
  form: {},
  ...overrides,
});

async function business(owner: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                             province, registration_number, date_registered)
     values ($1,$2,$3,'Retail','1 Main','Poblacion','Castilla','Sorsogon','DTI-1','2024-01-15')`,
    [id, owner, name],
  );
  return id;
}

/** A permit eBPCO issued: a filed application with its generated_permits row. */
async function issuedPermit(
  applicantId: string, permitNumber: string, options: { businessId: string | null; permitType: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                               application_action, lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,$4,$5,'New','Submitted','2025-02-01T00:00:00Z',$6)`,
    [id, `E-BPCO-2025-${permitNumber.slice(-6)}`, applicantId, options.businessId, options.permitType, OFFICIAL],
  );
  await db.query(
    `insert into generated_permits (application_id, permit_number, issued_date, generated_by)
     values ($1,$2,'2025-03-03T00:00:00Z',$3)`,
    [id, permitNumber, OFFICIAL],
  );
  return id;
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  submissions = new SubmissionService(db, () => NOW);
  queries = new ApplicantQueryService(db, {} as unknown as CalendarRepository, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','jose@example.ph','jose@example.ph','scrypt$1$1$1$a$b'),
            ($3,'staff','official@lgu.gov.ph','official@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [MARIA, JOSE, OFFICIAL],
  );
  mariaApplicant = randomUUID();
  joseApplicant = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name)
     values ($1,$2,'Maria','Santos'), ($3,$4,'Jose','Rizal')`,
    [mariaApplicant, MARIA, joseApplicant, JOSE],
  );
  bakery = await business(mariaApplicant, 'Santos Bakery');
  hardware = await business(mariaApplicant, 'Santos Hardware');
});

afterEach(async () => {
  await db.close();
});

const resolve = (permitNumber: string, overrides: { businessId?: string | null; permitType?: string } = {}) =>
  resolveRenewal(db, {
    action: 'Renewal', permitNumber, priorPermitClaim: null, applicantId: mariaApplicant,
    businessId: overrides.businessId === undefined ? bakery : overrides.businessId,
    permitType: overrides.permitType ?? 'Building Permit',
  });

describe('resolveRenewal', () => {
  it('links a permit that is theirs, for this business, of this type', async () => {
    const permitId = await issuedPermit(mariaApplicant, 'BP-2025-000007', {
      businessId: bakery, permitType: 'Building Permit',
    });

    expect(await resolve('BP-2025-000007')).toEqual({ ok: true, permitId, priorPermitClaim: null });
  });

  it('accepts the number however it was typed on a phone keyboard', async () => {
    const permitId = await issuedPermit(mariaApplicant, 'BP-2025-000007', {
      businessId: bakery, permitType: 'Building Permit',
    });

    expect(await resolve('  bp-2025-000007 ')).toEqual({ ok: true, permitId, priorPermitClaim: null });
  });

  it('refuses a number that is not a permit at all', async () => {
    const result = await resolve('BP');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-not-found');
  });

  it('refuses someone else\'s permit exactly as it refuses a missing one', async () => {
    const joseBusiness = await business(joseApplicant, 'Rizal Store');
    await issuedPermit(joseApplicant, 'BP-2025-000008', { businessId: joseBusiness, permitType: 'Building Permit' });

    const result = await resolve('BP-2025-000008', { businessId: joseBusiness });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not "wrong business": that would confirm the number exists.
    expect(result.reason).toBe('permit-not-found');
  });

  it('refuses their own permit when it was issued to a different business', async () => {
    await issuedPermit(mariaApplicant, 'BP-2025-000009', { businessId: hardware, permitType: 'Building Permit' });

    const result = await resolve('BP-2025-000009', { businessId: bakery });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-business-mismatch');
  });

  it('refuses their own permit when it is a different permit type', async () => {
    await issuedPermit(mariaApplicant, 'FP-2025-000010', { businessId: bakery, permitType: 'Fencing Permit' });

    const result = await resolve('FP-2025-000010', { permitType: 'Building Permit' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-type-mismatch');
    expect(result.issuedAs).toBe('Fencing Permit');
  });

  it('matches a permit issued to no business only when the filing names none either', async () => {
    const permitId = await issuedPermit(mariaApplicant, 'BP-2025-000011', {
      businessId: null, permitType: 'Building Permit',
    });

    expect(await resolve('BP-2025-000011', { businessId: null }))
      .toEqual({ ok: true, permitId, priorPermitClaim: null });
    const named = await resolve('BP-2025-000011', { businessId: bakery });
    expect(named.ok).toBe(false);
    if (named.ok) return;
    expect(named.reason).toBe('permit-business-mismatch');
  });

  it('still accepts a paper permit claim unverified', async () => {
    // The separate paper-permit path is untouched: it has nothing in the
    // database to be checked against, and submit() requires its proof.
    const result = await resolveRenewal(db, {
      action: 'Renewal', permitNumber: null, priorPermitClaim: 'BP-1998-000042', applicantId: mariaApplicant,
      businessId: bakery, permitType: 'Building Permit',
    });

    expect(result).toEqual({ ok: true, permitId: null, priorPermitClaim: 'BP-1998-000042' });
  });
});

describe('filing enforces it', () => {
  it('refuses a Renewal naming a permit of another business, and writes nothing', async () => {
    await issuedPermit(mariaApplicant, 'BP-2025-000012', { businessId: hardware, permitType: 'Building Permit' });

    const result = await submissions.submit({
      caller: maria,
      submission: submission({ applicationAction: 'Renewal', renewsPermitNumber: 'BP-2025-000012', businessId: bakery }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-business-mismatch');
    const filed = await db.query<{ n: string }>(
      `select count(*) as n from applications where application_action = 'Renewal'`,
    );
    expect(Number(filed.rows[0]?.n)).toBe(0);
  });

  it('files a Renewal naming a matching permit, linked to it', async () => {
    const permitId = await issuedPermit(mariaApplicant, 'BP-2025-000013', {
      businessId: bakery, permitType: 'Building Permit',
    });

    const result = await submissions.submit({
      caller: maria,
      submission: submission({ applicationAction: 'Renewal', renewsPermitNumber: 'BP-2025-000013', businessId: bakery }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.query<{ renews_permit_id: string }>(
      'select renews_permit_id from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]?.renews_permit_id).toBe(permitId);
  });

  it('refuses a draft saved with a permit of a different type', async () => {
    await issuedPermit(mariaApplicant, 'FP-2025-000014', { businessId: bakery, permitType: 'Fencing Permit' });

    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'Amendment', renewsPermitNumber: 'FP-2025-000014', businessId: bakery, saveAsDraft: true,
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-type-mismatch');
  });
});

describe('renewalCheck — what the wizard is told before Continue', () => {
  it('confirms a matching permit with what the citizen can recognise it by', async () => {
    await issuedPermit(mariaApplicant, 'BP-2025-000015', { businessId: bakery, permitType: 'Building Permit' });

    expect(await queries.renewalCheck(MARIA, {
      permitNumber: 'bp-2025-000015', permitType: 'Building Permit', businessId: bakery,
    })).toEqual({
      valid: true,
      permit: {
        permitNumber: 'BP-2025-000015', permitType: 'Building Permit', businessName: 'Santos Bakery',
        issuedDate: '2025-03-03T00:00:00.000Z',
      },
    });
  });

  it('says a made-up number does not exist, and points at the paper option', async () => {
    const result = await queries.renewalCheck(MARIA, {
      permitNumber: 'BP', permitType: 'Building Permit', businessId: bakery,
    });

    expect(result).toMatchObject({ valid: false, reason: 'permit-not-found' });
    if (result === null || result.valid) return;
    expect(result.message).toContain('does not exist');
    expect(result.message).toContain('paper');
  });

  it('names the mismatch when the permit belongs to another of their businesses', async () => {
    await issuedPermit(mariaApplicant, 'BP-2025-000016', { businessId: hardware, permitType: 'Building Permit' });

    const result = await queries.renewalCheck(MARIA, {
      permitNumber: 'BP-2025-000016', permitType: 'Building Permit', businessId: bakery,
    });

    expect(result).toMatchObject({ valid: false, reason: 'permit-business-mismatch' });
  });

  it('names what the permit actually is when the type differs', async () => {
    await issuedPermit(mariaApplicant, 'FP-2025-000017', { businessId: bakery, permitType: 'Fencing Permit' });

    const result = await queries.renewalCheck(MARIA, {
      permitNumber: 'FP-2025-000017', permitType: 'Building Permit', businessId: bakery,
    });

    expect(result).toMatchObject({ valid: false, reason: 'permit-type-mismatch' });
    if (result === null || result.valid) return;
    expect(result.message).toContain('is a Fencing Permit, not a Building Permit');
  });

  it('with no permit type named, matches on business alone and says what type the permit is', async () => {
    // The portal's generic flow: it learns the permit type FROM the permit.
    await issuedPermit(mariaApplicant, 'FP-2025-000018', { businessId: bakery, permitType: 'Fencing Permit' });

    expect(await queries.renewalCheck(MARIA, {
      permitNumber: 'FP-2025-000018', permitType: null, businessId: bakery,
    })).toMatchObject({ valid: true, permit: { permitType: 'Fencing Permit' } });
  });

  it('answers null for an account with no applicant profile', async () => {
    expect(await queries.renewalCheck(OFFICIAL, {
      permitNumber: 'BP-2025-000001', permitType: 'Building Permit', businessId: null,
    })).toBeNull();
  });
});
