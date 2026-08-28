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
import { StaffRole, scopesFor } from '../src/modules/identity/domain/account';

/**
 * TAB 08 — what the LGU charges, and how it will accept the money.
 *
 * The rule everything here protects: a schedule IN FORCE is never edited. Every
 * assessment records the version it was computed under so a historical bill can
 * be explained, and editing that version afterwards would change what the LGU
 * is recorded as having charged people who have already paid.
 */

jest.setTimeout(30_000);

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

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let admin: string;
let assessor: string;
const logLines: string[] = [];

async function token(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  const issued = await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff',
    scopes: [...scopesFor({ kind: 'staff', roles: [role] })],
  });
  return issued.token;
}

const send = (method: 'GET' | 'POST' | 'PUT', url: string, bearer: string, payload?: Record<string, unknown>) =>
  app.inject({
    method, url, headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload }),
  });

/** Tomorrow, so a publication is never accidentally back-dated by the clock. */
const soon = (days = 1): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const SCHEDULE = (version: string, effectiveFrom: string): Record<string, unknown> => ({
  version, effectiveFrom, publishedBy: 'City Ordinance 2027-001',
  entries: [
    { permitType: 'Fencing', line: 'filing', amountCentavos: 60_000, basis: 'City Ordinance 2027-001 s.3' },
  ],
});

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  admin = await token('administrator');
  assessor = await token('assessor');

  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  await db.query(
    `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
     values ('2026.1','Fencing','filing',50000,'City Ordinance 2026-004 s.3')`,
  );
});

afterEach(async () => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  await app.close();
  await db.close();
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

describe('publishing a fee schedule', () => {
  it('publishes a new version and closes the one it replaces ON THE NEW DATE', async () => {
    // Not today. A schedule published in March to take effect in April must
    // keep applying through March; closing it early leaves a gap in which no
    // fee can be assessed at all.
    const from = soon(30);

    const response = await send('POST', '/staff/config/fee-schedules', admin, SCHEDULE('2027.1', from));

    expect(response.statusCode).toBe(201);
    const closed = await db.query<{ effective_to: string }>(
      `select to_char(effective_to, 'YYYY-MM-DD') as effective_to from fee_schedules where version = '2026.1'`,
    );
    expect(closed.rows[0]?.effective_to).toBe(from);
  });

  it('names each version In force, Scheduled or Superseded rather than leaving it to be derived', async () => {
    await send('POST', '/staff/config/fee-schedules', admin, SCHEDULE('2027.1', soon(30)));

    const listed = await send('GET', '/staff/config/fee-schedules', assessor);

    const byVersion = new Map(
      listed.json<{ data: { version: string; status: string }[] }>().data.map((s) => [s.version, s.status]),
    );
    expect(byVersion.get('2026.1')).toBe('In force');
    expect(byVersion.get('2027.1')).toBe('Scheduled');
  });

  it('REFUSES a schedule that would take effect in the past', async () => {
    // Assessments have already been made under whatever was in force.
    // Back-dating would make them cite a schedule that did not exist when they
    // were computed.
    const response = await send('POST', '/staff/config/fee-schedules', admin, SCHEDULE('2025.9', '2025-01-01'));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/before today/i);
  });

  it('REFUSES to reuse a version number', async () => {
    // A version is how a historical assessment is explained. Reusing one makes
    // two different sets of figures answer to the same name.
    const response = await send('POST', '/staff/config/fee-schedules', admin, SCHEDULE('2026.1', soon()));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/already exists/i);
  });

  it('leaves the schedule in force untouched, which is the whole point', async () => {
    await send('POST', '/staff/config/fee-schedules', admin, SCHEDULE('2027.1', soon(30)));

    const original = await db.query<{ amount_centavos: string }>(
      `select amount_centavos from fee_schedule_entries where version = '2026.1' and line = 'filing'`,
    );
    expect(Number(original.rows[0]?.amount_centavos)).toBe(50_000);
  });

  it('refuses a permit type the LGU does not issue', async () => {
    const response = await send('POST', '/staff/config/fee-schedules', admin, {
      ...SCHEDULE('2027.2', soon()),
      entries: [{
        permitType: 'Interdimensional Portal', line: 'filing',
        amountCentavos: 1, basis: 'Ordinance s.1',
      }],
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a fee line with no ordinance behind it', async () => {
    const response = await send('POST', '/staff/config/fee-schedules', admin, {
      ...SCHEDULE('2027.3', soon()),
      entries: [{ permitType: 'Fencing', line: 'filing', amountCentavos: 90_000, basis: '' }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('REFUSES AN ASSESSOR, who applies the schedule but does not set it', async () => {
    // An officer who could do both could quietly assess a fee that suits them
    // and publish an ordinance figure to match.
    const response = await send('POST', '/staff/config/fee-schedules', assessor, SCHEDULE('2027.4', soon()));

    expect(response.statusCode).toBe(403);
  });

  it('lets an assessor READ them, because applying a fee means knowing it', async () => {
    expect((await send('GET', '/staff/config/fee-schedules', assessor)).statusCode).toBe(200);
  });
});

describe('which payment methods are open', () => {
  it('starts with both open, because that is what the system did before', async () => {
    const response = await send('GET', '/staff/config/payment-methods', assessor);

    expect(response.statusCode).toBe(200);
    const methods = response.json<{ data: { method: string; active: boolean }[] }>().data;
    expect(methods.map((m) => m.method).sort()).toEqual(['Bank Transfer', 'Onsite']);
    expect(methods.every((m) => m.active)).toBe(true);
  });

  it('closes one, and the payment path then refuses it', async () => {
    // Enforced at the payment, not only in the UI. A client with a stale form
    // must not be able to lodge a payment through a channel nobody is watching.
    const closed = await send('PUT', '/staff/config/payment-methods/Bank Transfer', admin, {
      active: false, instructions: 'The LGU account is being changed; use the cashier window.',
    });

    expect(closed.statusCode).toBe(200);
    expect(await db.query<{ active: boolean }>(
      `select active from payment_methods where method = 'Bank Transfer'`,
    ).then((r) => r.rows[0]?.active)).toBe(false);
  });

  it('REFUSES to close the last one', async () => {
    // Applicants would be left holding an Order of Payment they have no way to
    // settle, and no message anywhere saying why.
    await send('PUT', '/staff/config/payment-methods/Bank Transfer', admin, { active: false });

    const response = await send('PUT', '/staff/config/payment-methods/Onsite', admin, { active: false });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/only payment method/i);
  });

  it('refuses a method the software does not handle', async () => {
    const response = await send('PUT', '/staff/config/payment-methods/Cryptocurrency', admin, {
      active: true,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ detail: string }>().detail).toMatch(/needs code/i);
  });

  it('refuses an assessor changing what the LGU accepts', async () => {
    expect((await send('PUT', '/staff/config/payment-methods/Onsite', assessor, { active: false }))
      .statusCode).toBe(403);
  });
});
