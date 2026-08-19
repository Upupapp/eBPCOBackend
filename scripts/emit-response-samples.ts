/**
 * Records what the staff endpoints ACTUALLY return, against a real database.
 *
 * The contract repository validates these samples against its OpenAPI schemas.
 * That is the whole point of recording them rather than writing examples by
 * hand: a hand-written example states what someone believed the server returns,
 * and it agrees with the schema because the same person wrote both. These are
 * real bytes, from the real controllers, over the real route table, reading real
 * PostgreSQL — so a schema that disagrees with them disagrees with production.
 *
 * Run: npm run emit:samples
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { TokenService } from '../src/modules/identity/application/token.service';
import { ROLE_SCOPES, StaffRole } from '../src/modules/identity/domain/account';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

const target = process.argv[2]
  ?? resolve(__dirname, '../../ebpco-contract/reconciliation/response-samples.json');

const ENV: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-sample-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-sample-pepper-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

/**
 * The transition table, walked so a fixture reaches a status by a legal route.
 *
 * The database refuses an application created mid-lifecycle, and rightly: a row
 * that appeared at "Approved" never passed an evaluation. Samples that skipped
 * that would describe records production cannot produce.
 */
const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
  ['Assessed', 'Payment Submitted'], ['Payment Submitted', 'Payment Under Verification'],
  ['Payment Under Verification', 'Payment Verified'], ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
];

interface Seeded {
  official: string;
  records: string;
  applicantAccount: string;
  detailed: string;
  fresh: string;
  completed: string;
}

async function file(db: SqlClient, options: {
  applicant: string; business: string | null; charter: string; applicantAccount: string;
  reference: string; target: LifecycleStatus; submittedAt: string;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                               application_action, location, lifecycle_status, classification,
                               charter_entry_id, submitted_at, created_by)
     values ($1,$2,$3,$4,'Fencing','New','12 Rizal Street, Poblacion Uno, Cabuyao',
             'Submitted','Simple',$5,$6,$7)`,
    [id, options.reference, options.applicant, options.business, options.charter,
     options.submittedAt, options.applicantAccount],
  );

  let current: LifecycleStatus = 'Submitted';
  while (current !== options.target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no legal route from ${current} to ${options.target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  // The walk touches updated_at; the filing date is what the pledge measures from.
  await db.query('update applications set submitted_at = $1 where id = $2', [options.submittedAt, id]);
  return id;
}

/**
 * A dataset with enough shape that the samples exercise the fields that are
 * usually null.
 *
 * A sample where every optional field is absent proves nothing about the
 * schema's handling of the present case, and "it validated" would mean only
 * that nothing was checked.
 */
async function seed(db: SqlClient): Promise<Seeded> {
  const applicantAccount = randomUUID();
  const official = randomUUID();
  const records = randomUUID();

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria.santos@example.ph','maria.santos@example.ph','scrypt$1$1$1$a$b'),
            ($2,'staff','building.official@cabuyao.gov.ph','building.official@cabuyao.gov.ph','scrypt$1$1$1$a$b'),
            ($3,'staff','records@cabuyao.gov.ph','records@cabuyao.gov.ph','scrypt$1$1$1$a$b')`,
    [applicantAccount, official, records],
  );
  await db.query(
    `insert into account_roles (account_id, role) values ($1,'building-official'), ($2,'records-officer')`,
    [official, records],
  );

  const applicant = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicant, applicantAccount],
  );

  const business = randomUUID();
  await db.query(
    `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                             province, registration_number, date_registered, status)
     values ($1,$2,'Aling Nena Sari-Sari Store','Retail','12 Rizal Street','Poblacion Uno',
             'Cabuyao','Laguna','DTI-2024-004417','2024-01-15','Active')`,
    [business, applicant],
  );

  // A charter entry, so the pledge is a real computation rather than null in
  // every sample. The calendar is deliberately NOT marked complete: that is the
  // honest default under M-12, and it is the case a client is most likely to
  // render wrongly.
  const charter = randomUUID();
  await db.query(
    `insert into charter_entries (id, permit_type, classification, pledged_working_days,
                                  effective_from, fee_schedule_version, legal_basis)
     values ($1,'Fencing','Simple',7,'2026-01-01','2026.1','Citizen''s Charter 2026, p.14')`,
    [charter],
  );
  await db.query(`insert into holiday_calendars (year, complete) values (2026, false)`);
  await db.query(
    `insert into holidays (year, holiday_date, name, kind)
     values (2026,'2026-08-21','Ninoy Aquino Day','Special Non-Working Day'),
            (2026,'2026-08-31','National Heroes Day','Regular Holiday')`,
  );

  const detailed = await file(db, {
    applicant, business, charter, applicantAccount,
    reference: 'BP-2026-000041', target: 'Under Evaluation', submittedAt: '2026-08-10T01:30:00Z',
  });
  await db.query(
    `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                            byte_size, sha256, storage_key, status, scan_cleared, scanned_at)
     values ($1,$2,$3,'Valid identity document','psa-birth-certificate.pdf','application/pdf',
             182344,'3b1f2c9a4d8e7f60112233445566778899aabbccddeeff00112233445566778f',
             'documents/2026/08/psa.pdf','Approved',true,now())`,
    [randomUUID(), detailed, applicantAccount],
  );
  await db.query(
    `insert into evaluations (id, application_id, stage, result, evaluator_id, remarks, evaluated_at)
     values ($1,$2,'Zoning','Passed',$3,'Setbacks conform to the zoning ordinance.',now())`,
    [randomUUID(), detailed, official],
  );

  // An unresolved instruction, so the openInstructions shape is exercised
  // rather than validated as an empty array. A schema no sample reaches is a
  // schema nothing has checked.
  const letter = randomUUID();
  await db.query(
    `insert into letters_of_instruction (id, application_id, issued_at, issued_by)
     values ($1,$2,now(),$3)`,
    [letter, detailed, official],
  );
  await db.query(
    `insert into instruction_items (id, letter_id, subject, remark)
     values ($1,$2,'Lot plan','The submitted lot plan is not signed by a geodetic engineer.')`,
    [randomUUID(), letter],
  );

  const fresh = await file(db, {
    applicant, business: null, charter, applicantAccount,
    reference: 'BP-2026-000042', target: 'Submitted', submittedAt: '2026-08-18T02:00:00Z',
  });

  // A complete application, so the order of payment, payment, permit and
  // release schemas are exercised against real rows rather than against null.
  const completed = await file(db, {
    applicant, business, charter, applicantAccount,
    reference: 'BP-2026-000043', target: 'Ready for Release', submittedAt: '2026-07-02T01:00:00Z',
  });
  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  const order = randomUUID();
  await db.query(
    `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                    architectural_centavos, structural_centavos, electrical_centavos,
                                    others_centavos, total_centavos, fee_schedule_version,
                                    assessed_at, assessed_by, due_date)
     values ($1,$2,'OP-2026-000018',50000,120000,0,512000,0,0,682000,'2026.1',
             '2026-07-08T02:00:00Z',$3,'2026-07-23')`,
    [order, completed, official],
  );
  await db.query(
    `insert into payments (id, order_of_payment_id, application_id, reference_number,
                           amount_centavos, method, status, submitted_at, submitted_by,
                           verified_at, verified_by, official_receipt_number)
     values ($1,$2,$3,'BT-9931882',682000,'Bank Transfer','Paid','2026-07-10T03:00:00Z',$4,
             '2026-07-11T01:30:00Z',$5,'OR-2026-114772')`,
    [randomUUID(), order, completed, applicantAccount, official],
  );
  await db.query(
    `insert into generated_permits (application_id, permit_number, issued_date, scope, conditions, generated_by)
     values ($1,'FP-2026-000212','2026-07-20','Perimeter fence, 42 linear metres, hollow block on RC footing',
             array['Maintain a 1.5m setback from the property line.',
                   'Notify the Office of the Building Official before backfilling.'],$2)`,
    [completed, official],
  );
  await db.query(
    `insert into permit_releases (application_id, status, claim_location, office_hours, bring_with_you)
     values ($1,'Ready for Release','Office of the Building Official, 2/F Cabuyao City Hall',
             'Monday to Friday, 8:00am - 5:00pm',
             array['One valid government ID.', 'The Official Receipt.'])`,
    [completed],
  );

  return { official, records, applicantAccount, detailed, fresh, completed };
}

async function main(): Promise<void> {
  const db: SqlClient = await PgliteClient.create();
  await migrate(db, loadMigrations(resolve(__dirname, '../db/migrations')));

  const app: NestFastifyApplication = await createApp(
    loadConfig(ENV),
    new StructuredLogger('error', () => undefined),
    db,
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const tokens = app.get(TokenService);
  const seeded = await seed(db);

  const tokenFor = async (role: StaffRole, accountId: string): Promise<string> =>
    (await tokens.issueAccessToken({
      sub: accountId, sid: randomUUID(), kind: 'staff', scopes: [...ROLE_SCOPES[role]],
    })).token;

  const officialToken = await tokenFor('building-official', seeded.official);
  const recordsToken = await tokenFor('records-officer', seeded.records);

  const samples: Record<string, unknown> = {};

  async function record(
    name: string, method: 'GET' | 'POST', url: string, token: string,
    payload?: Record<string, unknown>, idempotencyKey?: string,
  ): Promise<void> {
    const response = await app.inject({
      method, url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    const [path, query] = url.split('?');
    samples[name] = {
      request: { method, path, query: query ?? null },
      status: response.statusCode,
      contentType: response.headers['content-type'],
      body: response.json(),
    };
  }

  await record('me.staff', 'GET', '/me', officialToken);
  // The applicant shape too: the two are different responses from one path, and
  // recording only the staff one is how the applicant half drifts unnoticed —
  // which is exactly what had already happened.
  const applicantToken = (await tokens.issueAccessToken({
    sub: seeded.applicantAccount, sid: randomUUID(), kind: 'applicant',
    scopes: ['profile:read', 'applications:read'],
  })).token;
  await record('me.applicant', 'GET', '/me', applicantToken);
  await record('staff.applications.list', 'GET', '/staff/applications?limit=3', officialToken);
  await record('staff.applications.list.filtered', 'GET', '/staff/applications?status=Submitted', officialToken);
  await record('staff.applications.metrics', 'GET', '/staff/applications/metrics', officialToken);
  await record('staff.applications.detail', 'GET', `/staff/applications/${seeded.detailed}`, officialToken);
  // A complete application as well as one mid-flight. Recording only the
  // in-progress case leaves the order of payment, the permit and the release
  // validated as null — which proves nothing about the shapes a client will
  // actually have to render.
  await record('staff.applications.detail.complete', 'GET',
    `/staff/applications/${seeded.completed}`, officialToken);

  // The refusals matter as much as the successes: a client that renders a
  // Problem Details body must be built against the real shape, and each of
  // these is a different next action for the officer at the counter.
  const moveKey = randomUUID();
  await record('staff.applications.transition.ok', 'POST',
    `/staff/applications/${seeded.fresh}/transitions`, recordsToken,
    { to: 'Received', expectedVersion: 1 }, moveKey);
  // The same key, the same body: a replay, which must return the original
  // result rather than a stale-version refusal. Recorded so a client can be
  // built against what a retry actually looks like.
  await record('staff.applications.transition.replay', 'POST',
    `/staff/applications/${seeded.fresh}/transitions`, recordsToken,
    { to: 'Received', expectedVersion: 1 }, moveKey);
  await record('problem.illegalTransition', 'POST',
    `/staff/applications/${seeded.fresh}/transitions`, recordsToken, { to: 'Approved' }, randomUUID());
  await record('problem.staleVersion', 'POST',
    `/staff/applications/${seeded.fresh}/transitions`, recordsToken,
    { to: 'Document Verification', expectedVersion: 1 }, randomUUID());
  await record('problem.missingIdempotencyKey', 'POST',
    `/staff/applications/${seeded.fresh}/transitions`, recordsToken, { to: 'Document Verification' });
  await record('problem.notFound', 'GET', `/staff/applications/${randomUUID()}`, officialToken);
  await record('problem.validation', 'GET', '/staff/applications?status=Nearly%20Done', officialToken);

  const document = {
    _comment:
      'GENERATED by ebpco-api/scripts/emit-response-samples.ts against a migrated PGlite database. ' +
      'Real responses from the real controllers over the real route table, not hand-written examples. ' +
      'The contract repository validates them against its OpenAPI schemas: a schema that disagrees ' +
      'with a sample here disagrees with what the server actually sends.',
    contractVersion: '0.1.0',
    samples,
  };

  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${target} (${Object.keys(samples).length} samples)\n`);

  await app.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
