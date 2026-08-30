import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { AppConfig, loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';

/**
 * Exercises the application exactly as `main.ts` builds it -- the same filters,
 * hooks and limits. A test that assembles its own reduced app proves that app,
 * not the one that ships.
 */

const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
  BUILD_COMMIT: 'abc1234',
  BUILD_TIME: '2026-08-19T12:00:00+08:00',
  ...overrides,
});

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

async function build(env: NodeJS.ProcessEnv = baseEnv()): Promise<{
  app: NestFastifyApplication;
  config: AppConfig;
  lines: string[];
  db: SqlClient;
}> {
  const config = loadConfig(env);
  const lines: string[] = [];
  // Real PostgreSQL, in-process. The end-to-end tests exercise the actual SQL
  // and the actual constraints rather than a stand-in written to agree.
  const db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  const app = await createApp(config, new StructuredLogger('info', (line) => lines.push(line)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, config, lines, db };
}

describe('operational endpoints', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await build());
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers liveness without touching anything', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers readiness with the contract shape', async () => {
    // The registry started empty in TAB 02 and is no longer: TAB 04 registers
    // the database probe. That is the design working -- each dependency
    // registers its own probe as it arrives, rather than four being listed up
    // front and reporting `up` against services that do not exist.
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    // Three probes now: the database (TAB 04), the object store and the
    // malware scanner (TAB 06). Each registered by the module that owns it, as
    // it arrived. The list grows on its own.
    const report = response.json<{ status: string; checks: Array<{ name: string; status: string }> }>();

    expect(report.status).toBe('ready');
    expect(report.checks.map((check) => check.name).sort()).toEqual([
      'database', 'malwareScanner', 'objectStore',
    ]);
    expect(report.checks.every((check) => check.status === 'up')).toBe(true);
  });

  it('reports the database as down when the schema is behind the code', async () => {
    // A deploy that skipped its migration step must fail its health gate rather
    // than serve requests against a schema it does not understand.
    const { app: behind, db } = await build();
    try {
      await db.query('delete from schema_migrations where version = (select max(version) from schema_migrations)');

      const response = await behind.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json<{ status: string }>().status).toBe('unavailable');
      expect(response.body).toContain('not applied');
    } finally {
      await behind.close();
    }
  });

  it('reports the build and the contract it implements', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commit: 'abc1234',
      environment: 'staging',
      contractVersion: '0.1.0',
      builtAt: '2026-08-19T12:00:00+08:00',
    });
  });

  it('serves the operational endpoints without credentials', async () => {
    // A probe that needs a token fails for the wrong reason during an identity
    // outage, and a load balancer has no credentials to offer.
    for (const url of ['/health', '/ready', '/version']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBeLessThan(400);
    }
  });
});

describe('error shape', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await build());
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns RFC 9457 problem+json for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: '/problems/not-found',
      status: 404,
      instance: '/no-such-route',
    });
  });

  it('carries a correlation id in the body of every error', async () => {
    // "It said something went wrong" is unactionable. The same report with an
    // id is a single log query.
    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    const body = response.json<{ correlationId?: string }>();
    expect(typeof body.correlationId).toBe('string');
  });

  it('rejects a body larger than the configured limit', async () => {
    const { app: small } = await build(baseEnv({ BODY_LIMIT_BYTES: '1024' }));
    try {
      const response = await small.inject({
        method: 'POST',
        url: '/health',
        payload: { blob: 'x'.repeat(4096) },
      });

      expect(response.statusCode).toBe(413);
      expect(response.headers['content-type']).toContain('application/problem+json');
    } finally {
      await small.close();
    }
  });
});

describe('correlation', () => {
  let app: NestFastifyApplication;
  let lines: string[];

  beforeAll(async () => {
    ({ app, lines } = await build());
  });
  afterAll(async () => {
    await app.close();
  });

  it('echoes a caller-supplied id back on the response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'caller-supplied-id' },
    });

    expect(response.headers['x-correlation-id']).toBe('caller-supplied-id');
  });

  it('generates one when the caller supplies none', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('refuses a forged id rather than repeating it into the logs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'a'.repeat(200) },
    });

    expect(response.headers['x-correlation-id']).not.toBe('a'.repeat(200));
  });

  it('logs the matched route, never the raw URL', async () => {
    // A raw URL carries path parameters, and a path parameter is an
    // applicant's application id.
    lines.length = 0;
    await app.inject({ method: 'GET', url: '/health' });

    const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.message === 'request');
    expect(request?.route).toBe('/health');
  });
});

describe('security headers', () => {
  it('sets a policy that permits nothing, since this service returns only JSON', async () => {
    const { app } = await build();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      const csp = String(response.headers['content-security-policy']);

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      // Asserting absence, not only presence: helmet's defaults merge in
      // script-src, style-src with 'unsafe-inline', and font-src https: unless
      // they are switched off. Every one of those is a permission granted to a
      // service that never emits markup.
      expect(csp).not.toContain('script-src');
      expect(csp).not.toContain('style-src');
      expect(csp).not.toContain('font-src');
      expect(csp).not.toContain('unsafe-inline');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-frame-options']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('sends HSTS outside development', async () => {
    // The S3 settings are here because production now REFUSES to boot on the
    // filesystem store -- documents on one container's disk do not survive a
    // redeploy. Nothing in this test touches storage; it is what a production
    // configuration has to contain in order to be one.
    const { app } = await build(baseEnv({
      EBPCO_ENVIRONMENT: 'production',
      OBJECT_STORE_DRIVER: 's3',
      OBJECT_STORE_REGION: 'ap-south-1',
    }));
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    } finally {
      await app.close();
    }
  });

  it('does not send HSTS in development', async () => {
    // Sending it from a plain-HTTP dev server teaches the browser to refuse the
    // developer's own localhost for the next six months.
    const { app } = await build(baseEnv({ EBPCO_ENVIRONMENT: 'development' }));
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('does not advertise the server implementation', async () => {
    const { app } = await build();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['x-powered-by']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('rate limiting', () => {
  it('rejects beyond the configured budget, in the contract error shape', async () => {
    const { app } = await build(baseEnv({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' }));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push((await app.inject({ method: 'GET', url: '/version' })).statusCode);
      }

      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);

      const limited = await app.inject({ method: 'GET', url: '/version' });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ type: '/problems/too-many-requests', status: 429 });
    } finally {
      await app.close();
    }
  });

  it('never rate-limits the probes infrastructure polls continuously', async () => {
    // Rate limiting these would take an instance out of rotation for the crime
    // of being monitored.
    const { app } = await build(baseEnv({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
        codes.push((await app.inject({ method: 'GET', url: '/ready' })).statusCode);
      }

      expect(codes.every((code) => code === 200)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('routing strictness', () => {
  it('does not serve a path that differs only by case or trailing slash', async () => {
    // One route means one path in the audit trail.
    const { app } = await build();
    try {
      expect((await app.inject({ method: 'GET', url: '/Health' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/health/' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
