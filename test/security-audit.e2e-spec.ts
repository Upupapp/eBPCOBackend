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

async function signInAs(email: string, password: string): Promise<string> {
  const response = await signIn(email, password);
  expect(response.statusCode).toBe(200);
  return response.json<{ accessToken: string }>().accessToken;
}

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

describe('a refused authorisation is recorded, and bounded', () => {
  it('records the first refusal, naming the route pattern and not the id', async () => {
    const applicantToken = await signInAs(EMAIL, PASSWORD);
    const target = randomUUID();

    const refused = await app.inject({
      method: 'GET', url: `/staff/applications/${target}`,
      headers: { authorization: `Bearer ${applicantToken}` },
    });
    expect(refused.statusCode).toBe(403);

    const entries = await db.query<{ after_state: { route: string; reason: string } }>(
      `select after_state from audit_events where action = 'authorisation.refused'`,
    );
    expect(entries.rows).toHaveLength(1);
    // The guard refuses on the ROUTE, before any record is read. An id here
    // would suggest a target was checked when none was.
    expect(entries.rows[0]!.after_state.route).toBe('/staff/applications/:id');
    expect(entries.rows[0]!.after_state.route).not.toContain(target);
  });

  it('writes ONE entry however many times the same account is refused', async () => {
    const applicantToken = await signInAs(EMAIL, PASSWORD);

    // Twenty-five refusals across different routes: the shape of a sweep. Keyed
    // on the account alone, so varying the path cannot hand the bound back.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await app.inject({
        method: 'GET', url: `/staff/applications/${randomUUID()}`,
        headers: { authorization: `Bearer ${applicantToken}` },
      });
      expect(response.statusCode).toBe(403);
    }

    // Every audit append takes the chain head FOR UPDATE. Unbounded, this is a
    // denial of service against the audit chain reachable by any applicant.
    const entries = await db.query(
      `select 1 from audit_events where action = 'authorisation.refused'`,
    );
    expect(entries.rows).toHaveLength(1);
  });

  it('still records a different account being refused in the same window', async () => {
    // The bound is per ACTOR. If it were global, one noisy client would hide
    // every other account's refusals -- which is the attack, not the defence.
    const first = await signInAs(EMAIL, PASSWORD);
    await post('/auth/register', {
      firstName: 'Jose', lastName: 'Rizal', email: 'jose.rizal@example.ph',
      mobileNumber: '+639171234568', password: PASSWORD,
    });
    const second = await signInAs('jose.rizal@example.ph', PASSWORD);

    for (const token of [first, first, second, second]) {
      await app.inject({
        method: 'GET', url: `/staff/applications/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    const entries = await db.query<{ actor_account_id: string }>(
      `select distinct actor_account_id from audit_events
        where action = 'authorisation.refused'`,
    );
    expect(entries.rows).toHaveLength(2);
  });

  it('refuses the request even when the entry cannot be written', async () => {
    // The refusal is the security control; the entry is the account of it.
    // Losing the account of it must never become letting the caller through.
    const applicantToken = await signInAs(EMAIL, PASSWORD);
    await db.query('drop table audit_events cascade');

    const response = await app.inject({
      method: 'GET', url: `/staff/applications/${randomUUID()}`,
      headers: { authorization: `Bearer ${applicantToken}` },
    });

    expect(response.statusCode).toBe(403);
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
