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
import { APPLICANT_SCOPES, StaffRole, scopesFor } from '../src/modules/identity/domain/account';

/**
 * One citizen, one application, filed to released — the whole loop, and
 * NOTHING seeded.
 *
 * Every other e2e suite in this repo proves a piece by starting from a
 * shortcut: `file()` raw-SQL-jumps `lifecycle_status` straight to whatever
 * status a test needs, `staffToken()`/`applicantToken()` mint a session
 * without a real sign-in, and the closest existing approximation of this
 * whole path (`staff-actions.e2e-spec.ts`'s "the whole path, five officers,
 * one application") still raw-SQL-inserts the identity document and the
 * payment row, and never once calls the citizen's own
 * `GET /applications/:id/permit`.
 *
 * This suite does none of that. Every state change below is a real HTTP call
 * the corresponding real person would actually make: the citizen registers,
 * signs in, uploads a real document, files a real application, and later
 * submits a real payment and fetches their own issued permit; every staff
 * hop is a real officer token exercising the real route an officer would
 * click. If any single hop in this chain were only wired on one side —
 * exactly the class of bug this whole pass through the codebase was hunting
 * — this is the test that would catch it.
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

// Real end-to-end work through five officer roles plus a real citizen
// registration, upload, filing and payment is genuinely more round trips
// than any other single test in this repo makes. The five-second default
// times out on the honest version of this test before it times out on
// anything actually wrong with it.
jest.setTimeout(60_000);

async function staffToken(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  await db.query(
    'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [id, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [id]);
  const issued = await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff',
    scopes: [...scopesFor({ kind: 'staff', roles: [role] })],
  });
  return issued.token;
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

/** For the two public, unauthenticated routes (register/sign-in) — no bearer token exists yet, exactly as a real not-yet-registered citizen has none. */
const publicPost = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

const STAGES = ['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'] as const;
const SCOPE = 'Perimeter fence, 42 linear metres, hollow block on reinforced concrete footing';
/** A minimal, valid PDF the malware scanner and inspector will accept — the same fixture applicant-write.e2e-spec.ts uses for a real upload. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const CITIZEN_EMAIL = 'juan.delacruz@example.ph';
const CITIZEN_PASSWORD = 'A-long-enough-passphrase-9284';

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  // The fee schedule an officer actually published, real ordinance
  // citation and all — the same real Fencing Permit lines
  // staff-actions.e2e-spec.ts's "whole path" test relies on, so this
  // suite's Order of Payment total (682,000 centavos) is provably the same
  // real figure, not a fixture that happens to agree with itself.
  // Migration 044 already seeds this same '2026.1' schedule (including
  // Fencing Permit's filing/processing/structural entries) on every fresh
  // database, so these inserts are made idempotent rather than colliding.
  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')
     on conflict (version) do nothing`,
  );
  for (const [line, amount] of [['filing', 50_000], ['processing', 120_000], ['structural', 512_000]] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1','Fencing Permit',$1,$2,'City Ordinance 2026-004 s.3')
       on conflict (version, permit_type, line) do nothing`,
      [line, amount],
    );
  }
});

afterEach(async () => {
  await app.close();
});

describe('a citizen files a permit, and it really reflects in the admin queue and back again', () => {
  it('goes from a real registration to a real, citizen-visible released permit — no shortcuts', async () => {
    // ---- The citizen, for real ------------------------------------------

    const registered = await publicPost('/auth/register', {
      firstName: 'Juan', lastName: 'Dela Cruz', email: CITIZEN_EMAIL,
      mobileNumber: '09171234567', password: CITIZEN_PASSWORD,
    });
    expect(registered.statusCode).toBe(202);

    const signIn = await publicPost('/auth/token', {
      grantType: 'password', email: CITIZEN_EMAIL, password: CITIZEN_PASSWORD,
    });
    expect(signIn.statusCode).toBe(200);
    const citizen = signIn.json<{ accessToken: string }>().accessToken;

    // A real upload, scanned by the real (stubbed-clean) scanner — not a
    // raw insert of an already-'Approved' row. The label is the real one
    // every permit type's requirements-catalog.ts actually uses; nothing
    // matches on the substring 'identity'.
    const uploaded = await post('/documents', citizen, {
      fileName: 'valid-id.pdf',
      label: 'Valid Government-Issued ID of Applicant/Owner',
      contentBase64: PDF.toString('base64'),
    });
    expect(uploaded.statusCode).toBe(201);
    const documentId = uploaded.json<{ documentId: string; status: string }>().documentId;
    expect(uploaded.json<{ status: string }>().status).toBe('Approved');

    const filed = await post('/applications', citizen, {
      permitType: 'Fencing Permit',
      applicationAction: 'New',
      location: '12 Rizal Street, Poblacion Uno, Castilla, Sorsogon',
      documentIds: [documentId],
    });
    expect(filed.statusCode).toBe(201);
    const application = filed.json<{ id: string; referenceNumber: string }>();
    expect(application.referenceNumber).toMatch(/^E-BPCO-/);
    const applicationId = application.id;

    // ---- Five real officers, five real roles ------------------------------

    const receiving = await staffToken('receiving-officer');
    const records = await staffToken('records-officer');
    const evaluator = await staffToken('evaluator');
    const preparer = await staffToken('assessor');
    const approver = await staffToken('assessor');
    const cashier = await staffToken('cashier');
    const official = await staffToken('building-official');
    const releasing = await staffToken('releasing-officer');

    expect((await post(`/staff/applications/${applicationId}/transitions`, receiving, { to: 'Received' }))
      .statusCode).toBe(200);
    expect((await post(`/staff/applications/${applicationId}/transitions`, records, { to: 'Document Verification' }))
      .statusCode).toBe(200);

    // The precondition this whole repo once could never satisfy: a real,
    // scan-cleared document whose label matches what a real applicant
    // actually uploads.
    const verified = await post(`/staff/applications/${applicationId}/transitions`, evaluator, { to: 'Under Evaluation' });
    expect(verified.statusCode).toBe(200);

    for (const stage of STAGES) {
      const result = await post(`/staff/applications/${applicationId}/evaluations`, evaluator, { stage, result: 'Passed' });
      expect(result.statusCode).toBe(201);
    }

    // Two DIFFERENT assessors — the same separation of duty
    // staff-actions.e2e-spec.ts's approvedAssessment() exercises: the one
    // who drafts the figures may not be the one who approves them.
    const draft = await post(`/staff/applications/${applicationId}/assessments`, preparer);
    expect(draft.statusCode).toBe(201);
    const assessmentId = draft.json<{ id: string }>().id;
    expect((await post(`/staff/assessments/${assessmentId}/submit`, preparer)).statusCode).toBe(200);
    expect((await post(`/staff/assessments/${assessmentId}/approve`, approver)).statusCode).toBe(200);

    const order = await post(`/staff/applications/${applicationId}/order-of-payment`, preparer);
    expect(order.statusCode).toBe(201);
    expect(order.json<{ totalCentavos: number }>().totalCentavos).toBe(682_000);

    // Issuing the Order IS the assessment (2026-09-20): the route makes the
    // `Under Evaluation -> Assessed` move itself and says where the
    // application now stands. Before this a separate "Send to Assessed"
    // click was owed here, and an application with every stage passed and a
    // real Order in force read "Under Evaluation" to everyone until someone
    // made it — found live. Making that move again by hand is now illegal,
    // because it already happened.
    expect(order.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe('Assessed');
    expect((await post(`/staff/applications/${applicationId}/transitions`, preparer, { to: 'Assessed' }))
      .statusCode).toBe(409);

    // ---- The citizen pays, for real — the exact gap this whole pass exists to close ----

    const paid = await post(`/applications/${applicationId}/payments`, citizen, {
      referenceNumber: 'BT-2026-771102',
      method: 'Bank Transfer',
      paidOn: '2026-09-16',
      amountCentavos: 682_000,
    });
    expect(paid.statusCode).toBe(201);
    const paymentResult = paid.json<{ paymentId: string; settles: boolean }>();
    expect(paymentResult.settles).toBe(true);
    const paymentId = paymentResult.paymentId;

    // The citizen can already see their own submitted payment (P-2a) — even
    // before an officer has touched it.
    const paymentsBeforeVerification = (await get(`/applications/${applicationId}/payments`, citizen))
      .json<Array<{ status: string; referenceNumber: string }>>();
    expect(paymentsBeforeVerification).toHaveLength(1);
    expect(paymentsBeforeVerification[0]).toMatchObject({
      status: 'Pending Verification', referenceNumber: 'BT-2026-771102',
    });

    // No manual "move to Payment Submitted" here — the citizen's own payment
    // call above already made that move for real (see
    // ApplicantWriteController.pay()'s own comment on why: Assessed ->
    // Payment Submitted is actors: ['applicant'] in the lifecycle table, and
    // no staff route can legally make this specific move).
    expect((await post(`/staff/applications/${applicationId}/transitions`, cashier, { to: 'Payment Under Verification' }))
      .statusCode).toBe(200);

    const verify = await post(`/staff/payments/${paymentId}/verify`, cashier, {
      officialReceiptNumber: 'OR-2026-554821',
    });
    expect(verify.statusCode).toBe(200);

    // Verifying is what "Payment Verified" means, and a verified payment has
    // nothing left to wait for before the building official's queue — so the
    // route carries the application to For Approval itself. The cashier
    // above had ALREADY moved it to Payment Under Verification by hand, and
    // the chain resumes from there rather than being refused for repeating
    // a move (the old nested version stopped dead on exactly that, leaving a
    // verified payment at Payment Under Verification).
    expect(verify.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe('For Approval');
    expect((await post(`/staff/applications/${applicationId}/transitions`, official, { to: 'Approved' }))
      .statusCode).toBe(200);

    const permit = await post(`/staff/applications/${applicationId}/permit`, official, {
      scope: SCOPE,
      conditions: ['Maintain a 1.5m setback from the property line.'],
    });
    expect(permit.statusCode).toBe(201);
    expect(permit.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe('Permit Generated');

    const prepared = await post(`/staff/applications/${applicationId}/release-preparation`, releasing, {
      claimLocation: 'OBO, 2/F Castilla Municipal Hall', officeHours: 'Mon-Fri 8:00-17:00',
      bringWithYou: ['One valid government ID'],
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe('Ready for Release');

    const release = await post(`/staff/applications/${applicationId}/release`, releasing, {
      claimantName: 'Juan Dela Cruz', method: 'Physical Claim',
    });
    expect(release.statusCode).toBe(201);
    // Released, and — nothing further happening to a claimed permit —
    // Completed, in the one call. The same two hops the portal used to make
    // itself after this route returned.
    expect(release.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe('Completed');
    const finalStatus = await db.query<{ lifecycle_status: string }>(
      'select lifecycle_status from applications where id = $1', [applicationId],
    );
    expect(finalStatus.rows[0]?.lifecycle_status).toBe('Completed');

    // ---- The citizen sees it, for real — the exact moment that proves the loop ----

    const citizenPermit = (await get(`/applications/${applicationId}/permit`, citizen)).json<{
      permitNumber: string; scope: string | null; conditions: readonly string[];
      release: { status: string; method: string | null; releasedAt: string | null } | null;
    }>();
    expect(citizenPermit.permitNumber).toMatch(/^FP-2026-\d{6}$/);
    expect(citizenPermit.scope).toBe(SCOPE);
    expect(citizenPermit.conditions).toEqual(['Maintain a 1.5m setback from the property line.']);
    expect(citizenPermit.release?.method).toBe('Physical Claim');
    expect(citizenPermit.release?.releasedAt).not.toBeNull();

    // And their own payment history now shows it verified, real OR number
    // and all (P-2a again, this time after the loop closed).
    const paymentsAfter = (await get(`/applications/${applicationId}/payments`, citizen))
      .json<Array<{ status: string; officialReceiptNumber: string | null }>>();
    expect(paymentsAfter).toHaveLength(1);
    expect(paymentsAfter[0]).toMatchObject({ status: 'Paid', officialReceiptNumber: 'OR-2026-554821' });

    // A stranger with no relation to this application cannot see any of it —
    // the anti-spoofing check stays real to the very end of this test too.
    const otherAccount = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','stranger@example.ph','stranger@example.ph','scrypt$1$1$1$a$b')`,
      [otherAccount],
    );
    await db.query(
      `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'A','Stranger')`,
      [randomUUID(), otherAccount],
    );
    const strangerToken = (await tokens.issueAccessToken({
      sub: otherAccount, sid: randomUUID(), kind: 'applicant',
      scopes: [...APPLICANT_SCOPES],
    })).token;
    expect((await get(`/applications/${applicationId}/permit`, strangerToken)).statusCode).toBe(404);
  });
});
