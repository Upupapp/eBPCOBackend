import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { createHmac } from 'node:crypto';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
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
  ...overrides,
});

const GOOD_PASSWORD = 'The quiet Barangay hall, on Tuesday at 3pm!';
// A second, equally policy-compliant password (upper/lower/digit/punctuation,
// 12+ chars, no context words) for tests that change AWAY from GOOD_PASSWORD.
const OTHER_GOOD_PASSWORD = 'The quiet Plaza bells ring again at 5pm!';

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

async function build(
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ app: NestFastifyApplication; lines: string[]; routes: string[]; db: SqlClient }> {
  const lines: string[] = [];
  // Real PostgreSQL, in-process, migrated. Every identity flow below therefore
  // runs against the constraints in db/migrations rather than around them.
  const db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  const app = await createApp(loadConfig(env(overrides)), new StructuredLogger('info', (l) => lines.push(l)), db);

  // The real route table, collected as Fastify registers each route. Parsing
  // printRoutes() output instead is how an earlier version of this test
  // silently checked `/refresh` rather than `/auth/token/refresh` -- and a
  // route-coverage test that quietly checks the wrong routes is worse than none.
  const routes: string[] = [];
  app.getHttpAdapter().getInstance().addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push(`${method} ${route.url}`);
    }
  });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, lines, routes, db };
}

const register = (app: NestFastifyApplication, email: string, password = GOOD_PASSWORD) =>
  app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { firstName: 'Maria', lastName: 'Santos', email, mobileNumber: '09171234567', password },
  });

const signIn = (app: NestFastifyApplication, email: string, password = GOOD_PASSWORD, totp?: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/token',
    payload: { grantType: 'password', email, password, ...(totp === undefined ? {} : { totp }) },
  });

/**
 * The documented public allow-list. Every other route in the application must
 * refuse an unauthenticated caller.
 */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /ready',
  'GET /version',
  'POST /auth/token',
  'POST /auth/token/refresh',
  'POST /auth/register',

  // Verifying an email BEFORE the account it will belong to exists — Step 2
  // of the web portal's registration wizard. Public for the same reason
  // /auth/register itself is: there is no account yet to hold a bearer
  // token for. Safe for the same reason: it cannot create an account by
  // itself (only /auth/register does that, and only once it has spent a
  // confirmed proof — see RegistrationVerificationService
  // .consumeConfirmedProof), and it works identically whether or not the
  // address already has one. Protected the same way /auth/register and
  // /auth/password/forgot already are — the global rate limiter, plus its
  // own 60-second resend floor per address — not the extra per-address/
  // per-IP limiter /auth/access-request carries, which exists there
  // because that endpoint puts a request in front of a super admin rather
  // than sending an email the requester themselves receives.
  'POST /auth/register/email/request',
  'POST /auth/register/email/confirm',

  'POST /auth/password/forgot',
  'POST /auth/password/reset',

  // Redeems a signed document link. Public BECAUSE the signature is the
  // authorisation — that is what a signed URL is for: a download fetched by a
  // browser, an image tag or a download manager, none of which carry a bearer
  // token. Everything a caller would normally be checked for was checked when
  // the link was minted, at an authenticated endpoint, which is why the link
  // lives for two minutes.
  //
  // It is on this list because this test refused it, correctly, the moment the
  // route existed. Adding a line here should always be a deliberate act.
  'GET /documents/content',

  // Asking to be given staff access. Public BECAUSE the person asking has no
  // account yet — that is the whole point: `/auth/register` mints an applicant
  // and can never mint staff, so there has to be some way to ask, and it cannot
  // require the credential it exists to obtain.
  //
  // What makes it safe to have on this list is not that it is harmless but that
  // it CANNOT CREATE AN ACCOUNT. It writes a row a super admin must act on, and
  // test/access-request-flow.e2e-spec.ts asserts that raising one creates no
  // account, no role, no level and no allow-list. It is also the only
  // unauthenticated write in the admin surface, so it is rate-limited per
  // address AND per IP, and it answers 202 identically whether or not the
  // address is known — matching /auth/register's anti-enumeration.
  'POST /auth/access-request',

  // The upload limits a client must not exceed.
  //
  // Public because a client needs them BEFORE it has a token: an upload screen
  // validates a file before the applicant has signed in to send it. Requiring
  // authentication would mean the one screen that most needs the number is the
  // one that cannot read it.
  //
  // What makes it safe is that it discloses nothing a caller cannot already
  // determine: a body limit is discoverable by sending one byte too many and
  // reading the 413. Publishing it saves every client from finding out that
  // way, and saves them from hard-coding a number that goes stale the moment
  // the limit is raised -- which is the defect it exists to prevent.
  //
  // It reads configuration and touches no database and no account.
  'GET /limits',
]);

describe('deny by default', () => {
  let app: NestFastifyApplication;
  let routes: string[];

  beforeAll(async () => {
    ({ app, routes } = await build());
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses every route that is not on the documented allow-list', async () => {
    // Enumerated from the application's own route table rather than from a
    // hand-written list, so a route added tomorrow is covered by this test
    // today. The failure mode being guarded against is someone forgetting.

    // A test that enumerates nothing passes vacuously.
    expect(routes.length).toBeGreaterThan(5);
    // And one that enumerates the wrong thing passes just as quietly, so pin
    // the shape too: every route is an absolute path.
    expect(routes.every((route) => route.split(' ')[1]?.startsWith('/'))).toBe(true);
    expect(routes).toEqual(expect.arrayContaining(['POST /auth/token/refresh', 'GET /me']));

    const wronglyOpen: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(' ');
      if (method === undefined || path === undefined) continue;
      if (PUBLIC_ROUTES.has(route)) continue;

      const response = await app.inject({
        method: method as 'GET',
        url: path.replace(/:(\w+)/g, 'probe'),
        // Spread rather than `payload: undefined`: under
        // exactOptionalPropertyTypes an explicit undefined is not the same as
        // an absent key, and inject rejects it.
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      if (response.statusCode !== 401) {
        wronglyOpen.push(`${route} -> ${response.statusCode}`);
      }
    }

    expect(wronglyOpen).toEqual([]);
  });

  it('refuses a request with no Authorization header', async () => {
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it.each([
    ['an empty bearer', 'Bearer '],
    ['the wrong scheme', 'Basic abc123'],
    ['a bare token', 'not-a-scheme'],
    ['a forged token', 'Bearer aaa.bbb.ccc'],
  ])('refuses %s', async (_label, authorization) => {
    const response = await app.inject({ method: 'GET', url: '/me', headers: { authorization } });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('gives one answer for expired, forged and malformed', async () => {
    // Telling a caller which would help them work out what they hold.
    const bodies = await Promise.all(
      ['Bearer aaa.bbb.ccc', 'Bearer x', 'Bearer '].map(async (authorization) => {
        const response = await app.inject({ method: 'GET', url: '/me', headers: { authorization } });
        const { correlationId: _ignored, ...rest } = response.json<Record<string, unknown>>();
        return rest;
      }),
    );

    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});

describe('registration over HTTP', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await build());
  });
  afterAll(async () => {
    await app.close();
  });

  it('accepts a new applicant', async () => {
    expect((await register(app, 'new@example.ph')).statusCode).toBe(202);
  });

  it('answers identically for an address that is already registered', async () => {
    // Otherwise this endpoint is an oracle for who has filed a permit here.
    const first = await register(app, 'twice@example.ph');
    const second = await register(app, 'twice@example.ph');

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
  });

  it('reports a weak password, because that is the caller’s own input', async () => {
    const response = await register(app, 'weak@example.ph', 'password1234');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors?: unknown[] }>().errors?.length).toBeGreaterThan(0);
  });

  it('rejects a malformed mobile number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { firstName: 'A', lastName: 'B', email: 'x@y.ph', mobileNumber: '12345', password: GOOD_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('/mobileNumber');
  });

  /**
   * Migration 036's middleName/street/barangay/city/province/postalCode,
   * added to this route 2026-09-19. The web portal's registration form has
   * required all six on Step 1/2 since before this route accepted them, so
   * a citizen who filled in a real address had it silently discarded —
   * caught live, reported by a citizen reading their own Profile screen
   * afterward and finding every address field blank.
   */
  it('saves middle name and address when the caller sends them, and returns them from /me', async () => {
    const email = 'full-address@example.ph';
    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        firstName: 'Maria', middleName: 'Santos', lastName: 'Dela Cruz', email,
        mobileNumber: '09171234567', password: GOOD_PASSWORD,
        street: '12 Rizal Street', barangay: 'Poblacion', city: 'Castilla',
        province: 'Sorsogon', postalCode: '4713',
      },
    });
    expect(registered.statusCode).toBe(202);

    const signedIn = await signIn(app, email);
    const { accessToken } = signedIn.json<{ accessToken: string }>();
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${accessToken}` } });

    expect(me.json()).toMatchObject({
      middleName: 'Santos', street: '12 Rizal Street', barangay: 'Poblacion',
      city: 'Castilla', province: 'Sorsogon', postalCode: '4713',
    });
  });

  it('still registers cleanly without any of the six — the mobile client sends none of them', async () => {
    const email = 'no-address@example.ph';
    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        firstName: 'Juan', lastName: 'Santos', email,
        mobileNumber: '09171234567', password: GOOD_PASSWORD,
      },
    });
    expect(registered.statusCode).toBe(202);

    const signedIn = await signIn(app, email);
    const { accessToken } = signedIn.json<{ accessToken: string }>();
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${accessToken}` } });

    // Null, not empty strings — NOT RECORDED, never "the citizen left it blank".
    expect(me.json()).toMatchObject({
      middleName: null, street: null, barangay: null, city: null, province: null, postalCode: null,
    });
  });

  it('rejects a malformed postal code the same way the address form itself would refuse to submit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        firstName: 'A', lastName: 'B', email: 'bad-postal@example.ph',
        mobileNumber: '09171234567', password: GOOD_PASSWORD, postalCode: '471',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('/postalCode');
  });
});

describe('verifying an email before it has an account', () => {
  let app: NestFastifyApplication;
  let db: SqlClient;

  beforeAll(async () => {
    ({ app, db } = await build());
  });
  afterAll(async () => {
    await app.close();
  });

  const requestCode = (email: string) =>
    app.inject({ method: 'POST', url: '/auth/register/email/request', payload: { email } });
  const confirmCode = (email: string, code: string) =>
    app.inject({ method: 'POST', url: '/auth/register/email/confirm', payload: { email, code } });

  /**
   * Same technique contact-verification.e2e-spec.ts's own plantCode() uses:
   * the code is peppered before storage (see
   * RegistrationVerificationService's own digestOf), so a test — same as a
   * real applicant — cannot read it back out. This replaces the digest with
   * one for a KNOWN code instead, which is closer to the truth: what a real
   * applicant has is the code, delivered by the mailer this suite does not
   * configure.
   */
  const plantCode = async (email: string, code = '424242'): Promise<string> => {
    const result = await db.query(
      `update registration_email_challenges set code_digest = $1
        where email = $2 and confirmed_at is null and consumed_at is null`,
      [createHmac('sha256', 'a-test-pepper-of-at-least-32-characters').update(code, 'utf8').digest('hex'),
       email.trim().toLowerCase()],
    );
    if (result.rowCount === 0) throw new Error(`no live registration challenge for ${email}`);
    return code;
  };

  it('records a request and, with no mail provider configured, says so honestly', async () => {
    const response = await requestCode('otp-web@example.ph');

    expect(response.statusCode).toBe(202);
    expect(response.json<{ delivery: string }>().delivery).toBe('not-sent');
  });

  it('refuses a confirm with no outstanding request', async () => {
    const response = await confirmCode('never-requested@example.ph', '123456');

    expect(response.statusCode).toBe(409);
  });

  it('refuses the wrong code without spending the challenge', async () => {
    await requestCode('wrong-code@example.ph');
    const real = await plantCode('wrong-code@example.ph');
    const wrong = real === '000000' ? '111111' : '000000';

    expect((await confirmCode('wrong-code@example.ph', wrong)).statusCode).toBe(409);
    // Still usable: one mistyped digit must not cost the applicant the code.
    expect((await confirmCode('wrong-code@example.ph', real)).statusCode).toBe(200);
  });

  it('refuses a second request within a minute', async () => {
    await requestCode('resend@example.ph');

    const response = await requestCode('resend@example.ph');

    expect(response.statusCode).toBe(409);
  });

  it('confirming alone does not create an account — only register() does that', async () => {
    await requestCode('confirmed-only@example.ph');
    await confirmCode('confirmed-only@example.ph', await plantCode('confirmed-only@example.ph'));

    const found = await db.query('select 1 from accounts where email = $1', ['confirmed-only@example.ph']);
    expect(found.rows.length).toBe(0);
  });

  it('a real registration for the confirmed email starts already Verified', async () => {
    const email = 'verified-at-signup@example.ph';
    await requestCode(email);
    await confirmCode(email, await plantCode(email));

    const registered = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { firstName: 'Ana', lastName: 'Reyes', email, mobileNumber: '09171234567', password: GOOD_PASSWORD },
    });
    expect(registered.statusCode).toBe(202);

    const signedIn = await signIn(app, email);
    const { accessToken } = signedIn.json<{ accessToken: string }>();
    const contacts = await app.inject({
      method: 'GET', url: '/me/contacts', headers: { authorization: `Bearer ${accessToken}` },
    });
    const emailState = contacts.json<{ data: { channel: string; status: string }[] }>()
      .data.find((c) => c.channel === 'email');
    // Both facts, not just the account's own column — GET /me/contacts reads
    // contact_verifications, a DIFFERENT table register() must also write or
    // this reads Unverified regardless of what accounts.email_verified_at says.
    expect(emailState?.status).toBe('Verified');

    const row = await db.query<{ email_verified_at: Date | null }>(
      'select email_verified_at from accounts where email_normalised = $1', [email],
    );
    expect(row.rows[0]?.email_verified_at).not.toBeNull();
  });

  it('an ordinary registration — no OTP step at all — still starts Unverified, exactly as before', async () => {
    // The mobile client's own registration request, unaffected: it never
    // calls register/email/request, and must keep registering cleanly.
    const email = 'no-otp-step@example.ph';
    const registered = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { firstName: 'Jose', lastName: 'Cruz', email, mobileNumber: '09171234567', password: GOOD_PASSWORD },
    });
    expect(registered.statusCode).toBe(202);

    const row = await db.query<{ email_verified_at: Date | null }>(
      'select email_verified_at from accounts where email_normalised = $1', [email],
    );
    expect(row.rows[0]?.email_verified_at).toBeNull();
  });

  it('a confirmed code cannot be replayed to verify a SECOND, different registration', async () => {
    const email = 'replay@example.ph';
    await requestCode(email);
    await confirmCode(email, await plantCode(email));

    // First registration spends the confirmed proof.
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { firstName: 'A', lastName: 'B', email, mobileNumber: '09171234567', password: GOOD_PASSWORD },
    });
    // Second "registration" for the same email is the anti-enumeration
    // no-op register() already gives any already-registered address — this
    // just confirms the proof itself was consumed, not left standing.
    const proofRow = await db.query<{ consumed_at: Date | null }>(
      `select consumed_at from registration_email_challenges
        where email = $1 and confirmed_at is not null order by issued_at desc limit 1`,
      [email],
    );
    expect(proofRow.rows[0]?.consumed_at).not.toBeNull();
  });
});

describe('sign-in over HTTP', () => {
  let app: NestFastifyApplication;
  let lines: string[];

  beforeAll(async () => {
    ({ app, lines } = await build());
    await register(app, 'maria@example.ph');
  });
  afterAll(async () => {
    await app.close();
  });

  it('issues a bearer token pair', async () => {
    const response = await signIn(app, 'maria@example.ph');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ tokenType: string; expiresIn: number }>()).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
    });
  });

  it('answers identically for an unknown account and a wrong password', async () => {
    const unknown = await signIn(app, 'nobody@example.ph');
    const wrong = await signIn(app, 'maria@example.ph', 'the wrong phrase entirely');

    expect(unknown.statusCode).toBe(wrong.statusCode);
    const strip = (body: string) => JSON.parse(body) as Record<string, unknown>;
    const { correlationId: _a, ...unknownBody } = strip(unknown.body);
    const { correlationId: _b, ...wrongBody } = strip(wrong.body);
    expect(unknownBody).toEqual(wrongBody);
  });

  it('never writes the password or the tokens to the log', async () => {
    lines.length = 0;
    await signIn(app, 'maria@example.ph');

    const written = lines.join('\n');
    expect(written).not.toContain('barangay');
    expect(written).not.toContain('maria@example.ph');
    expect(written).not.toContain('eyJ');
  });

  it('lets the issued token reach a protected route', async () => {
    const tokens = (await signIn(app, 'maria@example.ph')).json<{ accessToken: string }>();

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ email: string }>().email).toBe('maria@example.ph');
  });

  it('never returns credential material from /me', async () => {
    const tokens = (await signIn(app, 'maria@example.ph')).json<{ accessToken: string }>();
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    const body = response.body;
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('scrypt');
    expect(body).not.toContain('totpSecret');
  });
});

describe('refresh and revocation over HTTP', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    ({ app } = await build());
    await register(app, 'maria@example.ph');
  });
  afterEach(async () => {
    await app.close();
  });

  it('rotates the refresh token', async () => {
    const first = (await signIn(app, 'maria@example.ph')).json<{ refreshToken: string }>();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/token/refresh',
      payload: { refreshToken: first.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ refreshToken: string }>().refreshToken).not.toBe(first.refreshToken);
  });

  it('refuses a replayed refresh token without saying it was a replay', async () => {
    // A caller who learns the token was rejected *because it was replayed*
    // learns the theft was detected.
    const first = (await signIn(app, 'maria@example.ph')).json<{ refreshToken: string }>();
    await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: first.refreshToken } });

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/token/refresh',
      payload: { refreshToken: first.refreshToken },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.body).not.toContain('replay');
  });

  it('signs out one session', async () => {
    const tokens = (await signIn(app, 'maria@example.ph')).json<{ accessToken: string; refreshToken: string }>();

    const revoked = await app.inject({
      method: 'POST',
      url: '/auth/revoke',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {},
    });
    expect(revoked.statusCode).toBe(204);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/token/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('signs out everywhere', async () => {
    const phone = (await signIn(app, 'maria@example.ph')).json<{ accessToken: string; refreshToken: string }>();
    const browser = (await signIn(app, 'maria@example.ph')).json<{ refreshToken: string }>();

    await app.inject({
      method: 'POST',
      url: '/auth/revoke',
      headers: { authorization: `Bearer ${phone.accessToken}` },
      payload: { allSessions: true },
    });

    for (const token of [phone.refreshToken, browser.refreshToken]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/token/refresh',
        payload: { refreshToken: token },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('requires authentication to revoke', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/revoke', payload: {} })).statusCode).toBe(401);
  });
});

describe('account recovery over HTTP', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await build());
    await register(app, 'maria@example.ph');
  });
  afterAll(async () => {
    await app.close();
  });

  it('accepts a recovery request for an address that exists', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'maria@example.ph' },
    });

    expect(response.statusCode).toBe(202);
  });

  it('answers identically for an address that does not', async () => {
    const known = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'maria@example.ph' } });
    const unknown = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'nobody@example.ph' } });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
  });

  it('never returns the reset ticket in the response', async () => {
    // Returning it would make this endpoint a password reset for anyone who
    // knows an address.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'maria@example.ph' },
    });

    expect(response.body).toBe('');
  });

  it('refuses an unknown reset token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token: 'made-up', password: 'a different quiet phrase entirely' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('changing a password from inside a session', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await build());
    await register(app, 'maria@example.ph');
  });
  afterAll(async () => {
    await app.close();
  });

  const changePassword = (accessToken: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST', url: '/auth/password/change',
      headers: { authorization: `Bearer ${accessToken}` }, payload,
    });

  it('accepts the correct current password and lets the new one sign in', async () => {
    const signedIn = await signIn(app, 'maria@example.ph');
    const { accessToken } = signedIn.json<{ accessToken: string }>();

    const response = await changePassword(accessToken, {
      currentPassword: GOOD_PASSWORD, newPassword: OTHER_GOOD_PASSWORD,
    });
    expect(response.statusCode).toBe(204);

    const withOld = await signIn(app, 'maria@example.ph', GOOD_PASSWORD);
    expect(withOld.statusCode).toBe(401);
    const withNew = await signIn(app, 'maria@example.ph', OTHER_GOOD_PASSWORD);
    expect(withNew.statusCode).toBe(200);
  });

  it('refuses the wrong current password without touching the real one', async () => {
    await register(app, 'refuse-wrong@example.ph');
    const signedIn = await signIn(app, 'refuse-wrong@example.ph');
    const { accessToken } = signedIn.json<{ accessToken: string }>();

    const response = await changePassword(accessToken, {
      currentPassword: 'not what maria typed at all', newPassword: OTHER_GOOD_PASSWORD,
    });
    expect(response.statusCode).toBe(401);

    // The original password still works — a refused change must not be a
    // silent change.
    expect((await signIn(app, 'refuse-wrong@example.ph', GOOD_PASSWORD)).statusCode).toBe(200);
  });

  it('reports a weak new password with the same policy registration uses', async () => {
    await register(app, 'weak-change@example.ph');
    const signedIn = await signIn(app, 'weak-change@example.ph');
    const { accessToken } = signedIn.json<{ accessToken: string }>();

    const response = await changePassword(accessToken, {
      currentPassword: GOOD_PASSWORD, newPassword: 'password1234',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('/newPassword');
  });

  it('ends every other session, the same as a reset does', async () => {
    await register(app, 'end-sessions@example.ph');
    const first = await signIn(app, 'end-sessions@example.ph');
    const { accessToken, refreshToken } = first.json<{ accessToken: string; refreshToken: string }>();

    await changePassword(accessToken, {
      currentPassword: GOOD_PASSWORD, newPassword: OTHER_GOOD_PASSWORD,
    });

    const refreshed = await app.inject({
      method: 'POST', url: '/auth/token/refresh', payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });
});
