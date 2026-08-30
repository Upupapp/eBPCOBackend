import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';

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

const GOOD_PASSWORD = 'the quiet barangay hall on tuesday';

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
