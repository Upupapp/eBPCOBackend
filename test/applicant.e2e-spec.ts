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
import { APPLICANT_SCOPES, scopesFor } from '../src/modules/identity/domain/account';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * The applicant's own surface.
 *
 * Every screen in the mobile app ran on mock data until this TAB. What matters
 * most here is not that the routes exist but that the boundary holds: an
 * applicant must see their own applications and nothing else, and must never
 * see a field that belongs to the officer's view.
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

const MARIA = randomUUID();
const JOSE = randomUUID();
let mariaApplicant: string;
let joseApplicant: string;
let mariaApplication: string;
let joseApplication: string;

const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
];

async function file(applicantId: string, reference: string, target: LifecycleStatus): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               location, lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','12 Rizal Street','Submitted','2026-08-10T02:00:00Z',$4)`,
    [id, reference, applicantId, MARIA],
  );
  let current: LifecycleStatus = 'Submitted';
  while (current !== target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no route to ${target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  return id;
}

const applicantToken = async (accountId: string): Promise<string> =>
  (await tokens.issueAccessToken({
    sub: accountId, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
  })).token;

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','jose@example.ph','jose@example.ph','scrypt$1$1$1$a$b')`,
    [MARIA, JOSE],
  );
  mariaApplicant = randomUUID();
  joseApplicant = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name)
     values ($1,$2,'Maria','Santos'), ($3,$4,'Jose','Rizal')`,
    [mariaApplicant, MARIA, joseApplicant, JOSE],
  );
  mariaApplication = await file(mariaApplicant, 'BP-2026-000041', 'Under Evaluation');
  joseApplication = await file(joseApplicant, 'BP-2026-000042', 'Under Evaluation');
});

afterEach(async () => {
  await app.close();
});

describe('an applicant sees their own applications', () => {
  it('lists only theirs', async () => {
    const body = (await get('/applications', await applicantToken(MARIA)))
      .json<{ data: { referenceNumber: string }[] }>();

    // `data`, not `items`: the mobile client's list unwrapper accepts a bare
    // array or `data` and THROWS on anything else, so the wrong key is a crash
    // on a handset rather than a warning in a log.
    expect(body.data.map((i) => i.referenceNumber)).toEqual(['BP-2026-000041']);
  });

  it('answers 404 for someone else’s, not 403', async () => {
    // Telling an applicant that a reference exists but is not theirs confirms a
    // neighbour has applied for a permit.
    const response = await get(`/applications/${joseApplication}`, await applicantToken(MARIA));

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an id that is not a UUID, without touching the database', async () => {
    expect((await get('/applications/1%20or%201=1', await applicantToken(MARIA))).statusCode).toBe(404);
  });
});

describe('the officer/applicant boundary', () => {
  it('never returns an officer-only field', async () => {
    // The whitelist in toApplicantView is the only place this is enforced, and
    // it has to be: a field added to the record later is included by default if
    // the boundary is a delete-list, and the thing forgotten is an officer's
    // name or an internal evaluation stage.
    const body = await get(`/applications/${mariaApplication}`, await applicantToken(MARIA));
    const text = JSON.stringify(body.json());

    expect(text).not.toMatch(/officer|evaluationStage|applicantName|version/i);
  });

  it('returns the projected applicant status, not just the internal one', async () => {
    // Computed server-side and returned, so neither client recomputes it — two
    // implementations of a 19-to-7 projection is one that drifts.
    const body = (await get(`/applications/${mariaApplication}`, await applicantToken(MARIA)))
      .json<{ lifecycleStatus: string; applicantStatus: string }>();

    expect(body.lifecycleStatus).toBe('Under Evaluation');
    expect(body.applicantStatus).toBe('Under Review');
  });

  it('refuses a staff token rather than serving an empty list', async () => {
    // A staff token reaching here is a routing mistake. An empty list would
    // look like an officer with no applications, which is true and useless.
    const officer = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','o@lgu.gov.ph','o@lgu.gov.ph','scrypt$1$1$1$a$b')`, [officer],
    );
    const token = (await tokens.issueAccessToken({
      sub: officer, sid: randomUUID(), kind: 'staff', scopes: [...scopesFor({ kind: 'staff', roles: ['evaluator'] })],
    })).token;

    const response = await get('/applications', token);

    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/staff surface/i);
  });
});

describe('money the LGU has not assessed', () => {
  it('carries no amount at all — not zero, not null', async () => {
    // A null `totalCentavos` is something a client renders as "PHP 0.00", and
    // an applicant who reads that turns up at a cashier expecting to pay
    // nothing.
    const body = (await get(`/applications/${mariaApplication}`, await applicantToken(MARIA)))
      .json<{ payment: Record<string, unknown> }>();

    expect(body.payment).toEqual({ status: 'Not Yet Available' });
    expect(body.payment).not.toHaveProperty('orderOfPayment');
  });

  it('carries the Order of Payment once an officer has issued one', async () => {
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version, assessed_by, due_date)
       values ($1,$2,'OP-2026-000018',50000,120000,0,512000,0,0,682000,'2026.1',$3,'2026-12-31')`,
      [randomUUID(), mariaApplication, MARIA],
    );

    const body = (await get(`/applications/${mariaApplication}`, await applicantToken(MARIA)))
      .json<{ payment: { status: string; orderOfPayment: { totalCentavos: number } } }>();

    expect(body.payment.orderOfPayment.totalCentavos).toBe(682_000);
    // Still "Not Yet Available": the vocabulary has no term for "assessed but
    // unpaid", and the presence of the Order of Payment is what distinguishes
    // it. The mobile client groups this as "Due Now".
    expect(body.payment.status).toBe('Not Yet Available');
  });

  it('says Paid once a payment has been verified', async () => {
    // A separate verifier, because the database refuses a payment confirmed by
    // whoever submitted it — separation of duty at the row level, not just in
    // the service.
    const cashier = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','cashier@lgu.gov.ph','cashier@lgu.gov.ph','scrypt$1$1$1$a$b')`,
      [cashier],
    );
    const orderId = randomUUID();
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version, assessed_by)
       values ($1,$2,'OP-1',50000,120000,0,512000,0,0,682000,'2026.1',$3)`,
      [orderId, mariaApplication, MARIA],
    );
    await db.query(
      `insert into payments (id, order_of_payment_id, application_id, reference_number, amount_centavos,
                             method, status, submitted_by, verified_at, verified_by, official_receipt_number)
       values ($1,$2,$3,'BT-1',682000,'Bank Transfer','Paid',$4,now(),$5,'OR-1')`,
      [randomUUID(), orderId, mariaApplication, MARIA, cashier],
    );

    const body = (await get(`/applications/${mariaApplication}`, await applicantToken(MARIA)))
      .json<{ payment: { status: string } }>();

    expect(body.payment.status).toBe('Paid');
  });
});

describe('a pledge the LGU never made', () => {
  it('is absent rather than a blank countdown', async () => {
    // Where the Citizen's Charter has no entry, the client says "Awaiting
    // classification" rather than asserting a deadline.
    const body = (await get(`/applications/${mariaApplication}`, await applicantToken(MARIA))).json();

    expect(body).not.toHaveProperty('pledge');
    expect(body).not.toHaveProperty('classification');
  });
});

describe('the timeline', () => {
  it('shows what happened, without the internal desk it happened at', async () => {
    // An applicant does not need to know which office a file sat on, and the
    // pair of statuses reconstructs the officer's view of the pipeline.
    const entries = (await get(`/applications/${mariaApplication}/timeline`, await applicantToken(MARIA)))
      .json<Record<string, unknown>[]>();

    expect(entries.length).toBeGreaterThan(0);
    expect(Object.keys(entries[0]!)).toEqual(['status', 'occurredAt', 'remarks']);
  });

  it('is not readable for someone else’s application', async () => {
    expect((await get(`/applications/${joseApplication}/timeline`, await applicantToken(MARIA))).statusCode)
      .toBe(404);
  });
});

describe('notifications', () => {
  it('serves only the caller’s feed', async () => {
    // A notification body carries a reference number and often an address, so
    // serving the wrong feed discloses who has applied for what.
    for (const [account, title] of [[MARIA, 'Maria’s notice'], [JOSE, 'Jose’s notice']] as const) {
      await db.query(
        `insert into notifications (id, account_id, type, title, body)
         values ($1,$2,'application-submitted',$3,'Reference')`,
        [randomUUID(), account, title],
      );
    }

    const body = (await get('/notifications', await applicantToken(MARIA)))
      .json<{ data: { title: string }[] }>();

    expect(body.data.map((e) => e.title)).toEqual(['Maria’s notice']);
  });

  it('refuses to mark someone else’s as read', async () => {
    const notificationId = randomUUID();
    await db.query(
      `insert into notifications (id, account_id, type, title, body)
       values ($1,$2,'application-submitted','Jose’s notice','Reference')`,
      [notificationId, JOSE],
    );

    const response = await app.inject({
      method: 'POST', url: `/notifications/${notificationId}/read`,
      headers: { authorization: `Bearer ${await applicantToken(MARIA)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a muted category the server does not recognise', async () => {
    // Accepting it would leave the applicant with a switch that is set and does
    // nothing, and they keep getting the notices they asked not to.
    const response = await app.inject({
      method: 'PUT', url: '/notification-preferences',
      headers: { authorization: `Bearer ${await applicantToken(MARIA)}` },
      payload: {
        categories: { everythingPlease: false },
        quietHours: { enabled: true, start: '21:00', end: '07:00' },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('round-trips preferences', async () => {
    const token = await applicantToken(MARIA);
    await app.inject({
      method: 'PUT', url: '/notification-preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        categories: { payments: false },
        quietHours: { enabled: false, start: '22:00', end: '06:00' },
      },
    });

    const body = (await get('/notification-preferences', token))
      .json<{ categories: Record<string, boolean>; quietHours: { enabled: boolean; start: string } }>();

    expect(body.categories.payments).toBe(false);
    expect(body.quietHours).toEqual({ enabled: false, start: '22:00', end: '06:00' });
  });

  it('lists every category explicitly, including the enabled ones', async () => {
    // The contract allows "absent key means enabled". Relying on that makes an
    // enabled category and an unknown category look identical to a client —
    // fine until a category is added and every client silently treats it as on.
    const body = (await get('/notification-preferences', await applicantToken(MARIA)))
      .json<{ categories: Record<string, boolean> }>();

    expect(Object.keys(body.categories).sort()).toEqual([
      'account', 'applicationUpdates', 'appointments',
      'documentReminders', 'payments', 'permitStatus',
    ]);
  });
});

describe('devices', () => {
  it('never echoes the push token back', async () => {
    // It is a credential for sending to that handset, and a response repeating
    // it puts it in every proxy log between here and the phone.
    const response = await app.inject({
      method: 'POST', url: '/devices',
      headers: { authorization: `Bearer ${await applicantToken(MARIA)}` },
      payload: { platform: 'android', pushToken: 'a-real-looking-fcm-token', appVersion: '1.0.0' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(response.json())).not.toContain('a-real-looking-fcm-token');
  });

  it('stores the token ENCRYPTED, not merely in a column named for it', async () => {
    // The column has been called `push_token_encrypted` since it was created
    // and held the raw token until 2026-08-30, because no key had been chosen.
    // A push token is the ability to send a notification to a citizen's phone
    // as the LGU, so a database leak that yields live tokens hands someone a
    // phishing channel into a phone they trust.
    const response = await app.inject({
      method: 'POST', url: '/devices',
      headers: { authorization: `Bearer ${await applicantToken(MARIA)}` },
      payload: { platform: 'android', pushToken: 'a-real-looking-fcm-token' },
    });
    expect(response.statusCode).toBe(201);

    const stored = await db.query<{ push_token_encrypted: Uint8Array }>(
      'select push_token_encrypted from devices order by registered_at desc limit 1',
    );
    // `bytea` comes back as a Uint8Array rather than a Buffer, and a
    // `.toString()` on the wrong one yields comma-separated byte numbers that
    // look nothing like the token and would pass this assertion for the wrong
    // reason.
    const raw = Buffer.from(stored.rows[0]!.push_token_encrypted).toString('utf8');

    expect(raw).not.toContain('a-real-looking-fcm-token');
    // And it is a sealed envelope rather than something merely mangled: the
    // SecretBox format is version.nonce.body.tag.
    expect(raw.split('.')).toHaveLength(4);
  });

  it('registering the same handset twice does not create two', async () => {
    const token = await applicantToken(MARIA);
    const payload = { platform: 'android', pushToken: 'same-token' };

    await app.inject({ method: 'POST', url: '/devices', headers: { authorization: `Bearer ${token}` }, payload });
    await app.inject({ method: 'POST', url: '/devices', headers: { authorization: `Bearer ${token}` }, payload });

    const count = await db.query<{ n: string }>(
      'select count(*) as n from devices where account_id = $1', [MARIA],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });
});
