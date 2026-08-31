import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { TokenService } from '../src/modules/identity/application/token.service';
import { StaffRole, scopesFor } from '../src/modules/identity/domain/account';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * One application walked from filing to release, over HTTP, by five different
 * officers.
 *
 * Every previous test proved a piece. This proves the pieces connect — and it
 * is the only kind of test that can, because the thing being asserted is that
 * an evaluation written by one route satisfies a precondition read by another.
 */

const ENV: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
  PUSH_TOKEN_ENCRYPTION_KEY: 'a-test-push-key-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let applicantId: string;
const APPLICANT_ACCOUNT = randomUUID();

async function staffToken(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  // The access assignment migration 032 backfills for every real officer.
  // Without it the allow-list fails CLOSED and every transition is refused
  // `forms:<permit type>` — correct behaviour, and a fixture that skips it is
  // testing an officer no deployment produces.
  await db.query(
    'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [id, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [id]);
  const issued = await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff', // scopesFor(), not ROLE_SCOPES: production issues tokens through it, and it
    // grants profile:* to every account on top of the role's job scopes. A
    // helper that reads the role table directly quietly tests a narrower
    // token than any real caller holds.
    scopes: [...scopesFor({ kind: 'staff', roles: [role] })],
  });
  return issued.token;
}

/**
 * An Order of Payment now requires an APPROVED assessment behind it (TAB 05).
 *
 * Two officers, because that is the point: the one who prepares the figures may
 * not be the one who approves them. A test that used one token would pass only
 * while the separation of duty was broken.
 */
// Raised from the five-second default because the work is genuinely larger:
// since TAB 05 an Order of Payment requires a drafted, submitted and approved
// assessment behind it, which is three more round trips and two more accounts
// per test against a real PostgreSQL. The alternative — keeping the old limit
// by not exercising the approval — would be testing a flow that no longer
// exists.
jest.setTimeout(30_000);

let preparerToken: string | null = null;
let approverToken: string | null = null;

async function approvedAssessment(applicationId: string): Promise<void> {
  // Minted once PER TEST, not per call. Every call meant two account inserts
  // and two token signings, which pushed these tests past the five-second
  // default — a fixture cost masquerading as a slow endpoint. Caching across
  // tests fails differently and more confusingly: the database is rebuilt in
  // `beforeEach`, so a token from the previous test names an account that no
  // longer exists and the guard answers 401.
  preparerToken ??= await staffToken('assessor');
  // A SECOND ASSESSOR, not a building official. The review is four-eyes within
  // the assessing function — the same shape as evaluation's self-review rule,
  // where the refusal is between people holding the same role rather than
  // between roles. `staff:approve` is for approving the PERMIT.
  approverToken ??= await staffToken('assessor');
  const preparer = preparerToken;
  const approver = approverToken;
  const draft = await post(`/staff/applications/${applicationId}/assessments`, preparer);
  if (draft.statusCode !== 201) throw new Error(`draft failed: ${draft.body}`);
  const assessmentId = draft.json<{ id: string }>().id;
  const submitted = await post(`/staff/assessments/${assessmentId}/submit`, preparer);
  if (submitted.statusCode !== 200) throw new Error(`submit failed: ${submitted.body}`);
  const approved = await post(`/staff/assessments/${assessmentId}/approve`, approver);
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
}

const post = (
  url: string, token: string, payload: Record<string, unknown> = {}, key: string = randomUUID(),
) =>
  app.inject({
    method: 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload,
  });

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
  ['Assessed', 'Payment Submitted'], ['Payment Submitted', 'Payment Under Verification'],
  ['Payment Under Verification', 'Payment Verified'], ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
];

async function file(reference: string, target: LifecycleStatus): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','Submitted',now(),$4)`,
    [id, reference, applicantId, APPLICANT_ACCOUNT],
  );
  let current: LifecycleStatus = 'Submitted';
  while (current !== target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no route from ${current} to ${target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  return id;
}

const STAGES = ['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'] as const;
const SCOPE = 'Perimeter fence, 42 linear metres, hollow block on reinforced concrete footing';

beforeEach(async () => {
  preparerToken = null;
  approverToken = null;
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  for (const [line, amount] of [['filing', 50_000], ['processing', 120_000], ['structural', 512_000]] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1','Fencing',$1,$2,'City Ordinance 2026-004 s.3')`,
      [line, amount],
    );
  }
});

afterEach(async () => {
  await app.close();
});

describe('separation of duty, over HTTP', () => {
  it('refuses an evaluator issuing an Order of Payment', async () => {
    const id = await file('BP-1', 'Under Evaluation');

    const response = await post(`/staff/applications/${id}/order-of-payment`, await staffToken('evaluator'));

    expect(response.statusCode).toBe(403);
  });

  it('refuses an assessor generating a permit', async () => {
    const id = await file('BP-1', 'Approved');

    const response = await post(`/staff/applications/${id}/permit`,
      await staffToken('assessor'), { scope: SCOPE });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a cashier releasing a permit', async () => {
    const id = await file('BP-1', 'Ready for Release');

    const response = await post(`/staff/applications/${id}/release`,
      await staffToken('cashier'), { claimantName: 'Maria Santos', method: 'Physical Claim' });

    expect(response.statusCode).toBe(403);
  });
});

describe('recording an evaluation', () => {
  it('reports whether the application can now be assessed', async () => {
    // Returned with the write, so the portal does not need a second request
    // that would race the first.
    const id = await file('BP-1', 'Under Evaluation');
    const token = await staffToken('evaluator');

    const results = [];
    for (const stage of STAGES) {
      const response = await post(`/staff/applications/${id}/evaluations`, token, { stage, result: 'Passed' });
      results.push(response.json<{ evaluationsComplete: boolean }>().evaluationsComplete);
    }

    expect(results).toEqual([false, false, false, false, true]);
  });

  it('refuses an adverse result with nothing the applicant can act on', async () => {
    const id = await file('BP-1', 'Under Evaluation');

    const response = await post(`/staff/applications/${id}/evaluations`,
      await staffToken('evaluator'), { stage: 'Initial', result: 'Revision Required' });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/what the applicant has to fix/i);
  });

  it('refuses a stage out of turn, and names the one that is next', async () => {
    const id = await file('BP-1', 'Under Evaluation');

    const response = await post(`/staff/applications/${id}/evaluations`,
      await staffToken('evaluator'), { stage: 'OBO', result: 'Passed' });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain('Initial');
  });

  it('refuses a stage that is not one', async () => {
    const id = await file('BP-1', 'Under Evaluation');

    const response = await post(`/staff/applications/${id}/evaluations`,
      await staffToken('evaluator'), { stage: 'Vibes Check', result: 'Passed' });

    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for an application the evaluator may not read', async () => {
    const id = await file('BP-1', 'Ready for Release');

    const response = await post(`/staff/applications/${id}/evaluations`,
      await staffToken('evaluator'), { stage: 'Initial', result: 'Passed' });

    expect(response.statusCode).toBe(404);
  });
});

describe('the permit precondition that was missing', () => {
  it('refuses to announce a permit that does not exist', async () => {
    // Before this, Approved -> Permit Generated had no precondition. The
    // applicant was told their permit had been generated, and there was no
    // permit — and an applicant may travel to a counter on that notification.
    const id = await file('BP-1', 'Approved');

    const response = await post(`/staff/applications/${id}/transitions`,
      await staffToken('building-official'), { to: 'Permit Generated' });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/no permit has been generated/i);
  });

  it('allows it once a permit really has been generated', async () => {
    const id = await file('BP-1', 'Approved');
    const token = await staffToken('building-official');
    await post(`/staff/applications/${id}/permit`, token, { scope: SCOPE });

    const response = await post(`/staff/applications/${id}/transitions`, token, { to: 'Permit Generated' });

    expect(response.statusCode).toBe(200);
  });
});

describe('the cashier’s queue', () => {
  async function paymentAwaitingVerification(): Promise<{ paymentId: string; applicationId: string }> {
    const applicationId = await file('BP-1', 'Assessed');
    const orderId = randomUUID();
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version, assessed_by)
       values ($1,$2,'OP-1',50000,120000,0,512000,0,0,682000,'2026.1',$3)`,
      [orderId, applicationId, APPLICANT_ACCOUNT],
    );
    const paymentId = randomUUID();
    await db.query(
      `insert into payments (id, order_of_payment_id, application_id, reference_number, amount_centavos,
                             method, status, submitted_by)
       values ($1,$2,$3,'BT-1',682000,'Bank Transfer','Pending Verification',$4)`,
      [paymentId, orderId, applicationId, APPLICANT_ACCOUNT],
    );
    return { paymentId, applicationId };
  }

  it('shows what is waiting, with enough to match a bank statement', async () => {
    await paymentAwaitingVerification();

    const response = await get('/staff/payments', await staffToken('cashier'));

    expect(response.statusCode).toBe(200);
    const item = response.json<{ items: Record<string, unknown>[] }>().items[0]!;
    expect(item['referenceNumber']).toBe('BT-1');
    expect(item['amountCentavos']).toBe(682_000);
    expect(item['applicantName']).toBe('Maria Santos');
  });

  it('is closed to an evaluator', async () => {
    expect((await get('/staff/payments', await staffToken('evaluator'))).statusCode).toBe(403);
  });

  it('verifies against an Official Receipt number', async () => {
    const { paymentId } = await paymentAwaitingVerification();

    const response = await post(`/staff/payments/${paymentId}/verify`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-2026-114772' });

    expect(response.statusCode).toBe(200);
    const row = await db.query<{ official_receipt_number: string }>(
      'select official_receipt_number from payments where id = $1', [paymentId],
    );
    expect(row.rows[0]!.official_receipt_number).toBe('OR-2026-114772');
  });

  it('refuses to verify without one', async () => {
    // A verified payment with no receipt number cannot be reconciled against
    // the Treasurer's records, which is the only thing that makes it true.
    const { paymentId } = await paymentAwaitingVerification();

    const response = await post(`/staff/payments/${paymentId}/verify`, await staffToken('cashier'), {});

    expect(response.statusCode).toBe(400);
  });

  it('refuses a rejection with no reason the applicant can act on', async () => {
    // The money may genuinely have left their account.
    const { paymentId } = await paymentAwaitingVerification();

    const response = await post(`/staff/payments/${paymentId}/reject`,
      await staffToken('cashier'), { reason: 'no' });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a second verification', async () => {
    const { paymentId } = await paymentAwaitingVerification();
    const token = await staffToken('cashier');
    await post(`/staff/payments/${paymentId}/verify`, token, { officialReceiptNumber: 'OR-1' });

    const again = await post(`/staff/payments/${paymentId}/verify`, token, { officialReceiptNumber: 'OR-2' });

    expect(again.statusCode).toBe(409);
  });
});

describe('cash across a counter', () => {
  async function assessed(reference = 'BP-CASH'): Promise<{ applicationId: string; total: number }> {
    const applicationId = await file(reference, 'Under Evaluation');
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared, scanned_at)
       values ($1,$2,$3,'Valid identity document','psa.pdf','application/pdf',1024,
               '${'c'.repeat(64)}','documents/${reference}.pdf','Approved',true,now())`,
      [randomUUID(), applicationId, APPLICANT_ACCOUNT],
    );
    const evaluator = await staffToken('evaluator');
    for (const stage of STAGES) {
      await post(`/staff/applications/${applicationId}/evaluations`, evaluator, { stage, result: 'Passed' });
    }
    await approvedAssessment(applicationId);
    const order = await post(`/staff/applications/${applicationId}/order-of-payment`, await staffToken('assessor'));
    return { applicationId, total: order.json<{ totalCentavos: number }>().totalCentavos };
  }

  it('records the payment as settled, in one act', async () => {
    // The applicant hands over money and the cashier issues an Official
    // Receipt. That is one act, not two — modelling it as "record, then have
    // somebody else verify" asks an officer to confirm money they never
    // handled.
    const { applicationId, total } = await assessed();

    const response = await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-2026-114772', amountCentavos: total });

    expect(response.statusCode).toBe(201);
    const row = await db.query<{ status: string; method: string; official_receipt_number: string }>(
      'select status, method, official_receipt_number from payments where application_id = $1',
      [applicationId],
    );
    expect(row.rows[0]!.status).toBe('Paid');
    expect(row.rows[0]!.method).toBe('Onsite');
    expect(row.rows[0]!.official_receipt_number).toBe('OR-2026-114772');
  });

  it('records the APPLICANT as the one who paid, and the cashier as the one who received it', async () => {
    // Not a workaround for the separation-of-duty constraint — it is what
    // happened. Recording the cashier as submitter would be recording them as
    // having paid their own LGU's fee.
    const { applicationId, total } = await assessed();

    await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-1', amountCentavos: total });

    const row = await db.query<{ submitted_by: string; verified_by: string }>(
      'select submitted_by, verified_by from payments where application_id = $1', [applicationId],
    );
    expect(row.rows[0]!.submitted_by).toBe(APPLICANT_ACCOUNT);
    expect(row.rows[0]!.verified_by).not.toBe(APPLICANT_ACCOUNT);
  });

  it('names the cashier in the audit trail, where who handled the money belongs', async () => {
    const { applicationId, total } = await assessed();

    await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-1', amountCentavos: total });

    const audit = await db.query<{ n: string }>(
      `select count(*) as n from audit_events where action = 'payment.recorded-onsite'`,
    );
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });

  it('refuses a cashier receipting their own application', async () => {
    // Staff do apply for permits on their own houses. The database constraint
    // would refuse this anyway; answering here says why.
    const cashier = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','selfcashier@lgu.gov.ph','selfcashier@lgu.gov.ph','scrypt$1$1$1$a$b')`,
      [cashier],
    );
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [cashier, 'cashier']);
    const theirApplicant = randomUUID();
    await db.query(
      `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Cash','Ier')`,
      [theirApplicant, cashier],
    );
    const { total } = await assessed('BP-OTHER');
    const own = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'BP-OWN',$2,'Fencing','New','Submitted',now(),$3)`,
      [own, theirApplicant, cashier],
    );
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version, assessed_by)
       values ($1,$2,'OP-OWN',50000,120000,0,512000,0,0,$3,'2026.1',$4)`,
      [randomUUID(), own, total, APPLICANT_ACCOUNT],
    );
    const token = (await tokens.issueAccessToken({
      sub: cashier, sid: randomUUID(), kind: 'staff',
      scopes: [...scopesFor({ kind: 'staff', roles: ['cashier'] })],
    })).token;

    const response = await post(`/staff/applications/${own}/onsite-payment`, token,
      { officialReceiptNumber: 'OR-SELF', amountCentavos: total });

    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/your own application/i);
  });

  it('refuses a receipt that does not settle the Order of Payment', async () => {
    // ADR 0010: an LGU that accepts part of a fee has to track a balance, chase
    // it, and decide what a half-paid permit is.
    const { applicationId, total } = await assessed();

    const response = await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-1', amountCentavos: total - 1 });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/partial payments are not accepted/i);
  });

  it('refuses before an Order of Payment exists, and says so', async () => {
    const applicationId = await file('BP-NOOP', 'Under Evaluation');

    const response = await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'), { officialReceiptNumber: 'OR-1', amountCentavos: 1000 });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/no order of payment/i);
  });

  it('refuses a second receipt against an application already paid', async () => {
    const { applicationId, total } = await assessed();
    const cashier = await staffToken('cashier');
    await post(`/staff/applications/${applicationId}/onsite-payment`, cashier,
      { officialReceiptNumber: 'OR-1', amountCentavos: total });

    const again = await post(`/staff/applications/${applicationId}/onsite-payment`, cashier,
      { officialReceiptNumber: 'OR-2', amountCentavos: total });

    expect(again.statusCode).toBe(409);
  });

  it('records one payment however many times the receipt is replayed', async () => {
    const { applicationId, total } = await assessed();
    const cashier = await staffToken('cashier');
    const key = randomUUID();
    const receipt = { officialReceiptNumber: 'OR-1', amountCentavos: total };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await post(`/staff/applications/${applicationId}/onsite-payment`, cashier, receipt, key);
    }

    const count = await db.query<{ n: string }>(
      'select count(*) as n from payments where application_id = $1', [applicationId],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('is closed to an evaluator', async () => {
    const { applicationId, total } = await assessed();

    const response = await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('evaluator'), { officialReceiptNumber: 'OR-1', amountCentavos: total });

    expect(response.statusCode).toBe(403);
  });

  it('will not let a cashier record a bank transfer as cash', async () => {
    // No `method` field: this endpoint IS the onsite one. Letting a caller
    // choose would let a cashier record a transfer as though they had received
    // it in person.
    const { applicationId, total } = await assessed();

    const response = await post(`/staff/applications/${applicationId}/onsite-payment`,
      await staffToken('cashier'),
      { officialReceiptNumber: 'OR-1', amountCentavos: total, method: 'Bank Transfer' });

    expect(response.statusCode).toBe(400);
  });
});

describe('release', () => {
  async function readyForRelease(): Promise<string> {
    const id = await file('BP-1', 'Approved');
    await post(`/staff/applications/${id}/permit`, await staffToken('building-official'), { scope: SCOPE });
    await db.query(`update applications set lifecycle_status = 'Permit Generated' where id = $1`, [id]);
    await db.query(`update applications set lifecycle_status = 'Ready for Release' where id = $1`, [id]);
    return id;
  }

  it('refuses to release before the claim details exist', async () => {
    // An applicant needs a place and a time before they travel.
    const id = await readyForRelease();

    const response = await post(`/staff/applications/${id}/release`,
      await staffToken('releasing-officer'), { claimantName: 'Maria Santos', method: 'Physical Claim' });

    expect(response.statusCode).toBe(422);
  });

  it('records who collected it', async () => {
    const id = await readyForRelease();
    const token = await staffToken('releasing-officer');
    await post(`/staff/applications/${id}/release-preparation`, token, {
      claimLocation: 'Office of the Building Official, 2/F Cabuyao City Hall',
      officeHours: 'Monday to Friday, 8:00am - 5:00pm',
      bringWithYou: ['One valid government ID', 'The Official Receipt'],
    });

    const response = await post(`/staff/applications/${id}/release`, token, {
      claimantName: 'Maria Santos', method: 'Physical Claim',
    });

    expect(response.statusCode).toBe(201);
    const detail = (await get(`/staff/applications/${id}`, await staffToken('building-official')))
      .json<{ release: { claimantName: string; bringWithYou: string[] } }>();
    expect(detail.release.claimantName).toBe('Maria Santos');
    expect(detail.release.bringWithYou).toHaveLength(2);
  });
});

describe('the whole path, five officers, one application', () => {
  it('goes from filing to released without any status being asserted early', async () => {
    const id = await file('BP-2026-000041', 'Document Verification');
    // Document Verification -> Under Evaluation requires a verified identity
    // document and no missing or rejected ones. Without this the move is
    // refused and the application never leaves the receiving desk — which is
    // the precondition doing its job, and was how this test first failed.
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared, scanned_at)
       values ($1,$2,$3,'Valid identity document','psa.pdf','application/pdf',182344,
               '${'b'.repeat(64)}','documents/psa.pdf','Approved',true,now())`,
      [randomUUID(), id, APPLICANT_ACCOUNT],
    );
    const evaluator = await staffToken('evaluator');
    const assessor = await staffToken('assessor');
    const cashier = await staffToken('cashier');
    const official = await staffToken('building-official');
    const releasing = await staffToken('releasing-officer');

    await post(`/staff/applications/${id}/transitions`, evaluator, { to: 'Under Evaluation' });
    for (const stage of STAGES) {
      await post(`/staff/applications/${id}/evaluations`, evaluator, { stage, result: 'Passed' });
    }

    await approvedAssessment(id);
    const order = await post(`/staff/applications/${id}/order-of-payment`, assessor);
    expect(order.statusCode).toBe(201);
    expect(order.json<{ totalCentavos: number }>().totalCentavos).toBe(682_000);

    await post(`/staff/applications/${id}/transitions`, assessor, { to: 'Assessed' });

    // The applicant pays. Their half of this is TAB 09's routes; the row is
    // what the cashier's queue reads.
    const paymentId = randomUUID();
    const orderId = order.json<{ orderId: string }>().orderId;
    await db.query(
      `insert into payments (id, order_of_payment_id, application_id, reference_number, amount_centavos,
                             method, status, submitted_by)
       values ($1,$2,$3,'BT-9931882',682000,'Bank Transfer','Pending Verification',$4)`,
      [paymentId, orderId, id, APPLICANT_ACCOUNT],
    );
    await db.query(`update applications set lifecycle_status = 'Payment Submitted' where id = $1`, [id]);

    await post(`/staff/applications/${id}/transitions`, cashier, { to: 'Payment Under Verification' });
    await post(`/staff/payments/${paymentId}/verify`, cashier, { officialReceiptNumber: 'OR-2026-114772' });
    await post(`/staff/applications/${id}/transitions`, cashier, { to: 'Payment Verified' });
    await post(`/staff/applications/${id}/transitions`, cashier, { to: 'For Approval' });
    await post(`/staff/applications/${id}/transitions`, official, { to: 'Approved' });

    const permit = await post(`/staff/applications/${id}/permit`, official, {
      scope: SCOPE,
      conditions: ['Maintain a 1.5m setback from the property line.'],
    });
    expect(permit.statusCode).toBe(201);

    await post(`/staff/applications/${id}/transitions`, official, { to: 'Permit Generated' });
    await post(`/staff/applications/${id}/release-preparation`, releasing, {
      claimLocation: 'OBO, 2/F Cabuyao City Hall', officeHours: 'Mon-Fri 8:00-17:00',
      bringWithYou: ['One valid government ID'],
    });
    await post(`/staff/applications/${id}/transitions`, releasing, { to: 'Ready for Release' });
    await post(`/staff/applications/${id}/release`, releasing, {
      claimantName: 'Maria Santos', method: 'Physical Claim',
    });
    const released = await post(`/staff/applications/${id}/transitions`, releasing, { to: 'Released' });

    expect(released.statusCode).toBe(200);
    expect(released.json<{ status: string }>().status).toBe('Released');

    const detail = (await get(`/staff/applications/${id}`, official)).json<{
      summary: { lifecycleStatus: string };
      permit: { permitNumber: string };
      release: { claimantName: string };
      evaluations: unknown[];
      timeline: unknown[];
    }>();
    expect(detail.summary.lifecycleStatus).toBe('Released');
    expect(detail.permit.permitNumber).toMatch(/^FP-2026-\d{6}$/);
    expect(detail.release.claimantName).toBe('Maria Santos');
    expect(detail.evaluations).toHaveLength(5);
    expect(detail.timeline.length).toBeGreaterThanOrEqual(11);

    // The SHAPE, not just the count. Nothing pinned this, which is how the
    // detail view and EvaluationService.of could hold two near-identical
    // queries over the same rows without either one having to agree with the
    // other. They are one reader now, and this is what it must return.
    expect(detail.evaluations[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      stage: 'Initial',
      result: 'Passed',
      remarks: null,
      evaluatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as unknown,
    });
    // Decided in order, and reported in it.
    expect((detail.evaluations as Array<{ stage: string }>).map((e) => e.stage))
      .toEqual(['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval']);
  });
});
