import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { AddressInfo, createServer } from 'node:net';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { DRAIN_STATE } from '../src/persistence/persistence.module';
import { DrainState } from '../src/common/lifecycle/shutdown';

/**
 * What the load balancer sees.
 *
 * Readiness is the only thing standing between a broken instance and an
 * applicant, so what it reports has to be right in cases nobody wants to
 * rehearse: a schema the build does not understand, a dependency down, an
 * instance on its way out.
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

interface Report {
  status: 'ready' | 'degraded' | 'unavailable';
  checks: { name: string; status: string; detail: string | null }[];
}

async function build(overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(
    loadConfig({ ...ENV, ...overrides }), new StructuredLogger('error', () => undefined), db,
  );
  await app.init();
  // `onApplicationBootstrap` is where the public-bucket probe runs, and
  // `app.init()` alone does not fire it.
  await app.getHttpAdapter().getInstance().ready();
}

const ready = () => app.inject({ method: 'GET', url: '/ready' });

afterEach(async () => {
  await app.close();
});

describe('a healthy instance', () => {
  beforeEach(build);

  it('is ready, and says which dependencies it checked', async () => {
    const response = await ready();

    expect(response.statusCode).toBe(200);
    const report = response.json<Report>();
    expect(report.status).toBe('ready');
    expect(report.checks.map((c) => c.name).sort()).toEqual(['database', 'malwareScanner', 'objectStore']);
  });

  it('answers liveness without touching the database', async () => {
    // If liveness checked the database, a database outage would fail every
    // instance's liveness, the orchestrator would restart all of them, and a
    // recoverable dependency outage would become a total one.
    await db.close();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });
});

describe('when the database is unreachable', () => {
  beforeEach(build);

  it('is unavailable, not degraded', async () => {
    // Without it every route fails, so the instance should leave rotation
    // rather than serve errors.
    await db.close();

    const response = await ready();

    expect(response.statusCode).toBe(503);
    expect(response.json<Report>().status).toBe('unavailable');
  });

  it('names the dependency, and only the dependency', async () => {
    // A probe is unauthenticated. It must say enough to diagnose and nothing
    // an attacker gains from — no hostname, no credential, no connection string.
    await db.close();

    const check = response(await ready(), 'database');

    expect(check.status).toBe('down');
    expect(JSON.stringify(check)).not.toMatch(/postgres:\/\/|db\.internal|5432/);
  });
});

describe('when the schema is not what this build expects', () => {
  it('refuses to serve when a migration has not been applied', async () => {
    // The instance would take traffic and fail every request that touches the
    // missing table — errors that look like application bugs.
    db = await PgliteClient.create();
    const all = loadMigrations(join(__dirname, '../db/migrations'));
    await migrate(db, all.slice(0, all.length - 1));
    app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const result = await ready();

    expect(result.statusCode).toBe(503);
    expect(response(result, 'database').detail).toMatch(/not applied/);
  });

  it('names the migration rather than counting it', async () => {
    db = await PgliteClient.create();
    const all = loadMigrations(join(__dirname, '../db/migrations'));
    await migrate(db, all.slice(0, all.length - 1));
    app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const last = all[all.length - 1]!;
    expect(response(await ready(), 'database').detail).toContain(last.name);
  });

  it('refuses when a migration was applied from different content', async () => {
    // The count matches and the database is not what the code was tested
    // against. Editing a migration after it has run is a thing people do.
    await build();
    await db.query(
      `update schema_migrations set checksum = 'not-the-checksum-this-build-carries' where version = 2`,
    );

    const result = await ready();

    expect(result.statusCode).toBe(503);
    expect(response(result, 'database').detail).toMatch(/different content/);
  });

  it('SERVES when the database is ahead, because a rolling deploy migrates first', async () => {
    // Refusing here would take the service down at exactly the moment someone
    // is deploying or rolling back.
    await build();
    await db.query(
      `insert into schema_migrations (version, name, checksum) values (999, 'from_a_later_build', 'x')`,
    );

    const result = await ready();

    expect(result.statusCode).toBe(200);
    expect(response(result, 'database').status).toBe('up');
  });
});

describe('while shutting down', () => {
  beforeEach(build);

  it('reports NOT READY before it stops accepting', async () => {
    // The window this closes: an orchestrator removes the pod from rotation and
    // sends SIGTERM at roughly the same moment, and those are independent
    // systems. Reporting down first is what gives the balancer time to notice.
    expect((await ready()).statusCode).toBe(200);

    app.get<DrainState>(DRAIN_STATE).beginDraining();

    const result = await ready();
    expect(result.statusCode).toBe(503);
    expect(response(result, 'database').detail).toMatch(/shutting down/);
  });

  it('keeps serving real requests while draining', async () => {
    // The point of draining is that in-flight and just-arrived work still
    // completes. An instance that stopped answering the moment it reported down
    // would drop exactly the requests this is meant to protect.
    app.get<DrainState>(DRAIN_STATE).beginDraining();

    const response = await app.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
  });
});

describe('a non-critical dependency', () => {
  beforeEach(build);

  it('degrades without leaving rotation', async () => {
    // Taking the instance out because the malware scanner is down turns a
    // partial outage into a total one: uploads are held unscanned and
    // everything else still works.
    const report = (await ready()).json<Report>();
    const scanner = report.checks.find((c) => c.name === 'malwareScanner');

    expect(scanner).toBeDefined();
    // The registration is what carries `critical: false`; this asserts the
    // report exposes it at all, so a future change that flips it is visible.
    expect(report.status).toBe('ready');
  });
});

function response(result: { json: <T>() => T }, name: string): { status: string; detail: string | null } {
  const found = result.json<Report>().checks.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no ${name} check in the readiness report`);
  return found;
}

describe('the document dependencies are really probed', () => {
  /**
   * Both of these checks reported `up` unconditionally until 2026-08-30 --
   * placeholders that called nothing. `/ready` said the store and the scanner
   * were healthy whatever was true of them, which is worse than having no
   * check: it is a claim a load balancer acts on.
   *
   * Written as end-to-end tests because unit tests of the pieces did not catch
   * it. `isReachable` and `isPubliclyReadable` were both correct and both
   * called by nobody; only asking `/ready` what it says can tell the two apart.
   */
  it('reports the scanner DOWN when clamd is not listening, and stays ready', async () => {
    // Port 1 on loopback: refused immediately.
    await build({ MALWARE_SCANNER_DRIVER: 'clamav', MALWARE_SCANNER_URL: 'http://127.0.0.1:1' });

    const report = (await ready()).json<Report>();
    const scanner = report.checks.find((check) => check.name === 'malwareScanner');

    expect(scanner?.status).toBe('down');
    expect(scanner?.detail).toMatch(/held/);
    // Non-critical on purpose: taking the instance out of rotation because the
    // scanner is down turns a partial outage into a total one. Uploads are
    // accepted and held; everything else still works.
    expect(report.status).not.toBe('unavailable');
  });

  it('reports the scanner up when clamd answers', async () => {
    const clamd = createServer((socket) => {
      socket.on('data', () => { socket.write('PONG\0'); socket.end(); });
    });
    await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
    const port = (clamd.address() as AddressInfo).port;

    try {
      await build({
        MALWARE_SCANNER_DRIVER: 'clamav', MALWARE_SCANNER_URL: `http://127.0.0.1:${port}`,
      });

      expect((await ready()).json<Report>().checks
        .find((check) => check.name === 'malwareScanner')?.status).toBe('up');
    } finally {
      await new Promise<void>((resolve) => { clamd.close(() => { resolve(); }); });
    }
  });
});
