import { join } from 'node:path';

import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/bootstrap';
import { StructuredLogger } from '../src/common/logging/logger';
import { loadConfig } from '../src/config/app-config';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { PgliteClient } from '../src/persistence/pglite-client';

/**
 * The path a real applicant takes: register, sign in, file.
 *
 * D-9. Every other e2e suite here seeds `applicants` directly and proceeds,
 * which is right for testing a filing and means the SEAM between registration
 * and filing had never been crossed by anything. Registration created an
 * account and no profile; the first filing then failed 422 "This account has no
 * applicant profile", and no route existed to create one. 1,621 tests passed.
 *
 * So this suite is defined by what it does NOT do: it never touches the
 * database except to migrate it. If a fixture appears below, the test has
 * stopped asking the question it exists to ask.
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
let db: PgliteClient;

const EMAIL = 'maria.santos@example.ph';
const PASSWORD = 'a-long-enough-passphrase-2741';

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  // Both, and in this order: `init()` builds the container and `ready()` waits
  // for Fastify to finish registering routes. Without them every route 404s,
  // which reads exactly like a route that was never declared.
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300000);

afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (
  url: string, payload: Record<string, unknown>, headers: Record<string, string> = {},
) => app.inject({ method: 'POST', url, payload, headers });

describe('registering and then filing, with nothing seeded', () => {
  it('accepts the registration', async () => {
    const response = await post('/auth/register', {
      firstName: 'Maria', lastName: 'Santos', email: EMAIL,
      mobileNumber: '09171234567', password: PASSWORD,
    });

    expect(response.statusCode).toBe(202);
  });

  it('creates the applicant profile, not just the account', async () => {
    // The defect, stated directly. `accounts` had a row and `applicants` did
    // not, and nothing downstream could tell you why the filing failed.
    const accounts = await db.query<{ n: number }>(
      "select count(*)::int as n from accounts where kind = 'applicant'");
    const profiles = await db.query<{ n: number }>('select count(*)::int as n from applicants');

    expect(accounts.rows[0]!.n).toBe(1);
    expect(profiles.rows[0]!.n).toBe(1);
  });

  it('keeps the name and mobile number that were validated', async () => {
    // All three were validated and discarded. The mobile number in particular
    // was checked against ^(09\\d{9}|\\+639\\d{9})$ and then dropped, and the
    // service did not even accept the field.
    const row = await db.query<{ first_name: string; last_name: string; mobile: string | null }>(
      `select ap.first_name, ap.last_name, acc.mobile_number as mobile
         from applicants ap join accounts acc on acc.id = ap.account_id`);

    expect(row.rows[0]).toEqual({
      first_name: 'Maria', last_name: 'Santos', mobile: '09171234567',
    });
  });

  it('signs in', async () => {
    const response = await post('/auth/token', {
      grantType: 'password', email: EMAIL, password: PASSWORD,
    });

    expect(response.statusCode).toBe(200);
  });

  it('files an application — the hop that was impossible', async () => {
    const signIn = await post('/auth/token', {
      grantType: 'password', email: EMAIL, password: PASSWORD,
    });
    const { accessToken } = JSON.parse(signIn.body) as { accessToken: string };

    const response = await post('/applications', {
      permitType: 'New Construction',
      applicationAction: 'New',
      location: 'Purok 3, Cumadcad, Castilla, Sorsogon',
      form: { ownerName: 'Maria Santos', floorArea: 120 },
    }, {
      authorization: `Bearer ${accessToken}`,
      // Required on every write. Omitting it is a 400, not a default.
      'idempotency-key': '3f1a9c52-7b4e-4d1a-9f6c-2e8a5b0d4c11',
    });

    expect(response.statusCode).toBe(201);
    const filed = JSON.parse(response.body) as {
      referenceNumber: string; serviceDomain: string; form: Record<string, unknown>;
    };
    expect(filed.referenceNumber).toMatch(/^E-BPCO-/);
    // Derived by the server from permitType, and returned. A client that SENDS
    // it gets a 400: the submission shape is .strict() and does not declare it.
    expect(filed.serviceDomain).toBe('Construction Permit');
    expect(filed.form).toEqual({ ownerName: 'Maria Santos', floorArea: 120 });
  });

  it('reads the filing back by id, not from the list', async () => {
    const signIn = await post('/auth/token', {
      grantType: 'password', email: EMAIL, password: PASSWORD,
    });
    const { accessToken } = JSON.parse(signIn.body) as { accessToken: string };
    const list = await app.inject({
      method: 'GET', url: '/applications',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { data } = JSON.parse(list.body) as { data: { id: string }[] };

    const detail = await app.inject({
      method: 'GET', url: `/applications/${data[0]!.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect((JSON.parse(detail.body) as { form: unknown }).form)
      .toEqual({ ownerName: 'Maria Santos', floorArea: 120 });
  });
});
