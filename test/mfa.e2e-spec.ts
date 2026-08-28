import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { PasswordHasher } from '../src/modules/identity/domain/password-hasher';
import { codeFor, stepAt } from '../src/modules/identity/domain/totp';
import { StaffRole } from '../src/modules/identity/domain/account';

/**
 * Enrolling a second factor, and the six roles that could not sign in without one.
 *
 * `requiresMfa` has demanded a code from assessors, cashiers, building
 * officials, releasing officers and administrators since the role table was
 * written, and nothing could enrol one — so those roles could not sign in AT
 * ALL. Every other test in this repository mints its tokens directly, which is
 * why nothing caught it until a client was pointed at a running server.
 *
 * These tests sign in over HTTP, which is the only way that failure is visible.
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
  RATE_LIMIT_MAX: '10000',
};

const PASSWORD = 'a-correct-horse-battery-staple';

let app: NestFastifyApplication;
let db: SqlClient;
const logLines: string[] = [];

async function account(role: StaffRole | null): Promise<string> {
  const id = randomUUID();
  const hasher = new PasswordHasher(undefined, ENV.PASSWORD_PEPPER);
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,$2,$3,$3,$4)`,
    [id, role === null ? 'applicant' : 'staff', `${id.slice(0, 8)}@lgu.gov.ph`,
     await hasher.hash(PASSWORD)],
  );
  if (role !== null) {
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  }
  return id;
}

const emailOf = async (id: string): Promise<string> =>
  (await db.query<{ email: string }>('select email from accounts where id = $1', [id]))
    .rows[0]!.email;

const signIn = (email: string, totp?: string) => app.inject({
  method: 'POST', url: '/auth/token',
  payload: { grantType: 'password', email, password: PASSWORD, ...(totp === undefined ? {} : { totp }) },
});

const withToken = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({
    method, url, headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  await app.close();
  await db.close();
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

describe('the roles that could not sign in', () => {
  it('REFUSES an MFA role with no factor enrolled, which is where six roles were stuck', async () => {
    const id = await account('cashier');

    const response = await signIn(await emailOf(id));

    expect(response.statusCode).toBe(401);
    expect(response.json<{ type: string }>().type).toMatch(/mfa-required/);
  });

  it('lets that same officer sign in once they have enrolled', async () => {
    // The whole point. Enrolment is reachable without a second factor, because
    // the roles that need one cannot obtain it any other way.
    const id = await account('cashier');
    const email = await emailOf(id);

    // A role without MFA to obtain a token for the enrolment call would be
    // circular, so enrolment is done with the officer's own session — which
    // they cannot have. This is the gap the /me routes close: an account with
    // no factor still signs in far enough to enrol when its role does not
    // require one, and an MFA role is enrolled by an administrator resetting
    // it or at first issue. Here the enrolment is driven directly.
    const secret = await enrol(id);

    // The NEXT step. Activation spends the code that proved the enrolment, so
    // presenting the same one at sign-in is a replay and is rightly refused —
    // an officer enrolling and signing in seconds apart meets this, and it is
    // the guard working rather than a defect.
    const response = await signIn(email, codeFor(secret, stepAt(new Date()) + 1));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accessToken: string }>().accessToken).toBeTruthy();
  });

  it('refuses a code from a DIFFERENT secret', async () => {
    const id = await account('cashier');
    await enrol(id);

    const response = await signIn(await emailOf(id), codeFor('JBSWY3DPEHPK3PXP', stepAt(new Date()) + 1));

    expect(response.statusCode).toBe(401);
  });

  it('REFUSES A CODE ALREADY USED, inside the same thirty seconds', async () => {
    // Somebody who watched an officer type a code has that whole window.
    const id = await account('cashier');
    const email = await emailOf(id);
    const secret = await enrol(id);
    const code = codeFor(secret, stepAt(new Date()) + 1);

    expect((await signIn(email, code)).statusCode).toBe(200);
    expect((await signIn(email, code)).statusCode).toBe(401);
  });

  it('still lets a role that needs no second factor sign in without one', async () => {
    const id = await account('evaluator');

    expect((await signIn(await emailOf(id))).statusCode).toBe(200);
  });
});

describe('enrolling from the officer’s own session', () => {
  const tokenFor = async (role: StaffRole): Promise<{ id: string; token: string }> => {
    const id = await account(role);
    const response = await signIn(await emailOf(id));
    expect(response.statusCode).toBe(200);
    return { id, token: response.json<{ accessToken: string }>().accessToken };
  };

  it('reports whether a factor is needed and whether one is held', async () => {
    const { token } = await tokenFor('evaluator');

    const response = await withToken('GET', '/me/mfa', token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enrolled: false, required: false, pending: false });
  });

  it('offers a secret and a URI an authenticator app can scan', async () => {
    const { token } = await tokenFor('evaluator');

    const response = await withToken('POST', '/me/mfa/enrol', token);

    expect(response.statusCode).toBe(201);
    const body = response.json<{ secret: string; uri: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.uri).toContain('issuer=eBPCO');
  });

  it('CHANGES NOTHING ABOUT SIGNING IN until a code is confirmed', async () => {
    // An officer whose app failed to scan must not be locked out by the act of
    // trying to enrol.
    const { id, token } = await tokenFor('evaluator');
    await withToken('POST', '/me/mfa/enrol', token);

    const stored = await db.query<{ totp_secret_encrypted: string | null }>(
      'select totp_secret_encrypted from accounts where id = $1', [id],
    );
    expect(stored.rows[0]?.totp_secret_encrypted).toBeNull();
    expect((await signIn(await emailOf(id))).statusCode).toBe(200);
  });

  it('activates on a correct code, and only then', async () => {
    const { id, token } = await tokenFor('evaluator');
    const offer = (await withToken('POST', '/me/mfa/enrol', token))
      .json<{ secret: string }>();

    const wrong = await withToken('POST', '/me/mfa/activate', token, { code: '000000' });
    expect(wrong.statusCode).toBe(409);

    const right = await withToken('POST', '/me/mfa/activate', token, {
      code: codeFor(offer.secret, stepAt(new Date())),
    });
    expect(right.statusCode).toBe(200);

    const stored = await db.query<{ totp_secret_encrypted: string | null }>(
      'select totp_secret_encrypted from accounts where id = $1', [id],
    );
    expect(stored.rows[0]?.totp_secret_encrypted).not.toBeNull();
  });

  it('NEVER STORES THE SECRET IN PLAIN TEXT', async () => {
    // A database-only leak must yield ciphertext, not every officer's factor.
    const { id, token } = await tokenFor('evaluator');
    const offer = (await withToken('POST', '/me/mfa/enrol', token)).json<{ secret: string }>();
    await withToken('POST', '/me/mfa/activate', token, {
      code: codeFor(offer.secret, stepAt(new Date())),
    });

    const stored = await db.query<{ totp_secret_encrypted: Uint8Array }>(
      'select totp_secret_encrypted from accounts where id = $1', [id],
    );
    // `bytea`, so it arrives as bytes rather than a string.
    const sealed = Buffer.from(stored.rows[0]!.totp_secret_encrypted).toString('utf8');
    expect(sealed).not.toContain(offer.secret);
    expect(sealed).toMatch(/^v1\./);
  });

  it('refuses a second enrolment over a working one', async () => {
    const { token } = await tokenFor('evaluator');
    const offer = (await withToken('POST', '/me/mfa/enrol', token)).json<{ secret: string }>();
    await withToken('POST', '/me/mfa/activate', token, {
      code: codeFor(offer.secret, stepAt(new Date())),
    });

    const again = await withToken('POST', '/me/mfa/enrol', token);

    expect(again.statusCode).toBe(409);
    expect(again.json<{ detail: string }>().detail).toMatch(/already has an authenticator/i);
  });

  it('refuses activation when no enrolment was started', async () => {
    const { token } = await tokenFor('evaluator');

    const response = await withToken('POST', '/me/mfa/activate', token, { code: '123456' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/start an enrolment first/i);
  });

  it('refuses anything that is not six digits', async () => {
    const { token } = await tokenFor('evaluator');
    await withToken('POST', '/me/mfa/enrol', token);

    for (const code of ['12345', 'abcdef', '']) {
      expect((await withToken('POST', '/me/mfa/activate', token, { code })).statusCode).toBe(400);
    }
  });
});

/** Drives enrolment directly, for the roles that cannot obtain a session first. */
async function enrol(accountId: string): Promise<string> {
  const { TotpService } = await import('../src/modules/identity/application/totp.service');
  const { SecretBox } = await import('../src/modules/identity/domain/secret-box');
  const service = new TotpService(db, new SecretBox(ENV.TOTP_ENCRYPTION_KEY!), 'eBPCO staging');

  const offer = await service.begin({ accountId });
  if (!offer.ok) throw new Error(`enrolment refused: ${offer.detail}`);
  const activated = await service.activate({
    accountId, code: codeFor(offer.value.secret, stepAt(new Date())),
  });
  if (!activated.ok) throw new Error(`activation refused: ${activated.detail}`);
  return offer.value.secret;
}
