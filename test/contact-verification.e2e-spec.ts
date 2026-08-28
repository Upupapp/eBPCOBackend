import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { TokenService } from '../src/modules/identity/application/token.service';
import { APPLICANT_SCOPES } from '../src/modules/identity/domain/account';

/**
 * M-45 — proving the LGU can reach an applicant.
 *
 * THE SUCCESS PATH IS NOT REACHABLE BY A HUMAN. There is no email or SMS
 * provider, so no code is ever delivered. These tests read the digest out of
 * the database to get past that, which is exactly what an applicant cannot do
 * — and every refusal below is a refusal a real applicant would meet.
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

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let account: string;
let token: string;
const logLines: string[] = [];

const send = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method, url, headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

/**
 * Puts a KNOWN code in the outstanding challenge.
 *
 * The service never reveals the code, and reversing a SHA-256 digest by trying
 * a million candidates took twenty seconds a call — a test that slow is one
 * that gets deleted. This replaces the digest instead, which is closer to the
 * truth anyway: what a real applicant has is the code, and the only thing that
 * could give it to them is a delivery adapter that does not exist.
 */
const plantCode = async (channel: string, code = '424242'): Promise<string> => {
  const result = await db.query(
    `update contact_verification_challenges set code_digest = $1
      where account_id = $2 and channel = $3 and consumed_at is null`,
    [createHash('sha256').update(code, 'utf8').digest('hex'), account, channel],
  );
  if (result.rowCount === 0) throw new Error(`no live challenge for ${channel}`);
  return code;
};

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  account = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b','+639171234567')`,
    [account],
  );
  token = (await tokens.issueAccessToken({
    sub: account, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
  })).token;
});

afterEach(async () => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  await app.close();
  await db.close();
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

describe('what the applicant is told', () => {
  it('reports both channels, including one with nothing to verify', async () => {
    // "Nothing to verify" is its own state. An absent channel would read to a
    // client as missing rather than unverified.
    await db.query('update accounts set mobile_number = null where id = $1', [account]);

    const response = await send('GET', '/me/contacts');

    expect(response.statusCode).toBe(200);
    const data = response.json<{ data: { channel: string; value: string; status: string }[] }>().data;
    expect(data.map((c) => c.channel)).toEqual(['email', 'mobile']);
    expect(data.find((c) => c.channel === 'mobile')).toMatchObject({ value: '', status: 'Unverified' });
  });

  it('uses the admin’s exact wire vocabulary, which the app parses strictly', async () => {
    // The Flutter client throws `UnknownWireValue` on anything else, so these
    // strings are the contract rather than a presentation choice.
    await send('POST', '/me/contacts/email/request');

    const data = (await send('GET', '/me/contacts'))
      .json<{ data: { channel: string; status: string }[] }>().data;
    expect(data.find((c) => c.channel === 'email')?.status).toBe('Pending Verification');
  });

  it('SAYS NOTHING WAS SENT, rather than telling them to check their messages', async () => {
    // There is no provider. An applicant told to wait for a code that is not
    // coming is worse off than one told the office has to do it.
    const response = await send('POST', '/me/contacts/email/request');

    expect(response.statusCode).toBe(202);
    const body = response.json<{ delivery: string; detail: string }>();
    expect(body.delivery).toBe('not-sent');
    expect(body.detail).toMatch(/no message provider/i);
  });

  it('NEVER returns the code', async () => {
    // An applicant who can read the code in the reply has proved only that they
    // can read their own screen — the fabrication the mobile client refused to
    // perform from the other side.
    const response = await send('POST', '/me/contacts/mobile/request');
    const code = await plantCode('mobile');

    expect(response.body).not.toContain(code);
    expect(response.body).not.toMatch(/\b\d{6}\b/);
  });
});

describe('confirming a code', () => {
  it('verifies the channel, and records how', async () => {
    await send('POST', '/me/contacts/mobile/request');

    const response = await send('POST', '/me/contacts/mobile/confirm', { code: await plantCode('mobile') });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; method: string }>()).toMatchObject({
      status: 'Verified', method: 'Mobile OTP',
    });
  });

  it('sets the account column that has existed since the first migration and nothing ever set', async () => {
    await send('POST', '/me/contacts/email/request');
    await send('POST', '/me/contacts/email/confirm', { code: await plantCode('email') });

    const row = await db.query<{ email_verified_at: Date | null }>(
      'select email_verified_at from accounts where id = $1', [account],
    );
    expect(row.rows[0]?.email_verified_at).not.toBeNull();
  });

  it('refuses a wrong code without spending the challenge', async () => {
    await send('POST', '/me/contacts/mobile/request');
    const real = await plantCode('mobile');
    const wrong = real === '000000' ? '111111' : '000000';

    expect((await send('POST', '/me/contacts/mobile/confirm', { code: wrong })).statusCode).toBe(409);
    // Still usable: one mistyped digit must not cost the applicant the code.
    expect((await send('POST', '/me/contacts/mobile/confirm', { code: real })).statusCode).toBe(200);
  });

  it('SPENDS the challenge after five wrong codes, and says it FAILED not merely unverified', async () => {
    // Six digits is a million guesses, which is nothing to a machine. And
    // "somebody tried and it did not work" is a different fact from "nobody
    // tried" — the app models them separately and the applicant is owed it.
    await send('POST', '/me/contacts/mobile/request');
    const real = await plantCode('mobile');
    const wrong = real === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await send('POST', '/me/contacts/mobile/confirm', { code: wrong });
    }

    const after = await send('POST', '/me/contacts/mobile/confirm', { code: real });
    expect(after.statusCode).toBe(409);
    const state = (await send('GET', '/me/contacts'))
      .json<{ data: { channel: string; status: string }[] }>().data;
    expect(state.find((c) => c.channel === 'mobile')?.status).toBe('Verification Failed');
  });

  it('refuses an expired code and says how long they last', async () => {
    await send('POST', '/me/contacts/email/request');
    const code = await plantCode('email');
    // BOTH timestamps move. `expires_at > issued_at` is a constraint, and a
    // challenge that expired before it was issued is nonsense the database is
    // right to refuse — the fixture was wrong, not the schema.
    await db.query(
      `update contact_verification_challenges
          set issued_at = now() - interval '20 minutes',
              expires_at = now() - interval '5 minutes'
        where account_id = $1`, [account],
    );

    const response = await send('POST', '/me/contacts/email/confirm', { code });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/expired/i);
  });

  it('refuses a confirm when nothing was ever asked for', async () => {
    const response = await send('POST', '/me/contacts/email/confirm', { code: '123456' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/ask for a code first/i);
  });

  it('refuses anything that is not six digits before it reaches a hash', async () => {
    await send('POST', '/me/contacts/email/request');

    for (const code of ['12345', 'abcdef', '1234567', '']) {
      expect((await send('POST', '/me/contacts/email/confirm', { code })).statusCode).toBe(400);
    }
  });
});

describe('what it refuses to start', () => {
  it('refuses a channel with no value to verify', async () => {
    await db.query('update accounts set mobile_number = null where id = $1', [account]);

    const response = await send('POST', '/me/contacts/mobile/request');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/add a mobile number/i);
  });

  it('refuses a second code within a minute, because each SMS costs the LGU money', async () => {
    await send('POST', '/me/contacts/mobile/request');

    const response = await send('POST', '/me/contacts/mobile/request');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/wait/i);
  });

  it('refuses to re-verify a channel already verified', async () => {
    await send('POST', '/me/contacts/email/request');
    await send('POST', '/me/contacts/email/confirm', { code: await plantCode('email') });

    const response = await send('POST', '/me/contacts/email/request');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/already verified/i);
  });

  it('refuses a channel that does not exist', async () => {
    expect((await send('POST', '/me/contacts/telegram/request')).statusCode).toBe(404);
  });

  it('keeps only ONE live challenge, so an attacker gets one guess per request', async () => {
    await send('POST', '/me/contacts/email/request');
    await db.query(
      `update contact_verification_challenges set issued_at = now() - interval '5 minutes'
        where account_id = $1`, [account],
    );
    await send('POST', '/me/contacts/email/request');

    const live = await db.query<{ n: string }>(
      `select count(*) as n from contact_verification_challenges
        where account_id = $1 and consumed_at is null`, [account],
    );
    expect(Number(live.rows[0]?.n)).toBe(1);
  });
});
