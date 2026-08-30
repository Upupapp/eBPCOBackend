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
import { scopesFor } from '../src/modules/identity/domain/account';

/**
 * D-6 over HTTP: the access and security streams are real records, not logs.
 *
 * The assertions that matter are what a refused sign-in DOES NOT say. Everything
 * else here would pass against an implementation that wrote the attempted email
 * into an append-only table.
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

const PASSWORD = 'a-long-enough-passphrase-42';
const EMAIL = 'maria.santos@example.ph';

interface Entry {
  action: string; outcome: string; actorAccountId: string | null;
  subjectId: string | null; sourceAddress: string | null;
}

let app: NestFastifyApplication;
let db: SqlClient;
let auditorToken: string;
const logLines: string[] = [];

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

const signIn = (email: string, password: string) =>
  post('/auth/token', { grantType: 'password', email, password });

const streamOf = async (stream: string): Promise<Entry[]> => {
  const response = await app.inject({
    method: 'GET', url: `/staff/audit?stream=${stream}&limit=200`,
    headers: { authorization: `Bearer ${auditorToken}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ entries: Entry[] }>().entries;
};

const actionsIn = async (stream: string): Promise<string[]> =>
  (await streamOf(stream)).map((entry) => entry.action);

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const tokens = app.get(TokenService);
  const auditorId = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [auditorId, `auditor-${auditorId.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query("insert into account_roles (account_id, role) values ($1,'auditor')", [auditorId]);
  auditorToken = (await tokens.issueAccessToken({
    sub: auditorId, sid: randomUUID(), kind: 'staff',
    scopes: [...scopesFor({ kind: 'staff', roles: ['auditor'] })],
  })).token;

  const registered = await post('/auth/register', {
    email: EMAIL, password: PASSWORD, firstName: 'Maria', lastName: 'Santos',
    mobileNumber: '+639171234567',
  });
  expect([202, 201, 200]).toContain(registered.statusCode);
}, 60_000);

afterEach(async () => {
  await app.close();
  await db.close();
  logLines.length = 0;
});

describe('a refused sign-in tells a reader nothing about who was tried', () => {
  it('records the same entry for an unknown address and a wrong password', async () => {
    expect((await signIn('nobody@example.ph', PASSWORD))
      .statusCode).toBe(401);
    expect((await signIn(EMAIL, 'the-wrong-passphrase-42'))
      .statusCode).toBe(401);

    const refusals = (await streamOf('security'))
      .filter((entry) => entry.action === 'session.refused');

    expect(refusals).toHaveLength(2);
    // The whole point. If either entry named the account, the presence of the
    // field would say which email exists -- undoing the decoy hash that makes
    // the two paths take the same time.
    for (const entry of refusals) {
      expect(entry.actorAccountId).toBeNull();
      expect(entry.subjectId).toBeNull();
    }
    expect(refusals[0]!.action).toBe(refusals[1]!.action);
    expect(refusals[0]!.outcome).toBe(refusals[1]!.outcome);
  });

  it('never writes the attempted address anywhere in the entry', async () => {
    await signIn('someone.else@example.ph', PASSWORD);

    const raw = await db.query<{ row: string }>(
      `select row_to_json(a)::text as row from audit_events a where action = 'session.refused'`,
    );

    // Checked against the whole row rather than a field list: a future change
    // that put the address in before_state or after_state would pass a
    // field-by-field assertion.
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.row).not.toContain('someone.else');
  });
});

describe('a successful sign-in is a record', () => {
  it('names the account and where it came from', async () => {
    expect((await signIn(EMAIL, PASSWORD)).statusCode).toBe(200);

    const started = (await streamOf('access'))
      .find((entry) => entry.action === 'session.started');

    expect(started).toBeDefined();
    expect(started!.actorAccountId).not.toBeNull();
    // The column has carried an NPC Circular 16-01 basis since it was created
    // and was null on every row in the table until D-6.
    expect(started!.sourceAddress).not.toBeNull();
  });
});

describe('the three streams', () => {
  it('keeps sign-ins out of the activity stream and business acts out of access', async () => {
    await signIn(EMAIL, PASSWORD);
    await signIn(EMAIL, 'wrong-passphrase-here-42');

    const access = await actionsIn('access');
    const security = await actionsIn('security');
    const activity = await actionsIn('activity');

    expect(access).toContain('session.started');
    expect(security).toContain('session.refused');
    // Activity is defined by subtraction, so a new audited business act appears
    // there without anyone maintaining a list -- and a sign-in never does.
    expect(activity).not.toContain('session.started');
    expect(activity).not.toContain('session.refused');
  });

  it('returns everything when no stream is named', async () => {
    await signIn(EMAIL, PASSWORD);

    const all = await app.inject({
      method: 'GET', url: '/staff/audit?limit=200',
      headers: { authorization: `Bearer ${auditorToken}` },
    });

    expect(all.json<{ entries: Entry[] }>().entries.map((e) => e.action))
      .toContain('session.started');
  });

  it('refuses a stream name it does not have', async () => {
    const response = await app.inject({
      method: 'GET', url: '/staff/audit?stream=error',
      headers: { authorization: `Bearer ${auditorToken}` },
    });

    // `error` and `events` are the two tabs D-6 deliberately does not serve.
    // Answering with an empty list would read as "no errors".
    expect(response.statusCode).toBe(400);
  });
});
