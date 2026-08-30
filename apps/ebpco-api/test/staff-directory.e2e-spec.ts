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
 * TAB 01 — the Users & Roles screen, over HTTP.
 *
 * The assertions that carry weight are the refusals. An administration API is
 * a privilege-escalation surface by construction: it is the one place where a
 * caller can change what callers may do.
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
let tokens: TokenService;
let adminId: string;
let adminToken: string;
/**
 * Kept, not removed. A 500 from these routes otherwise arrives as an opaque
 * problem document -- the first failure here was `column a.totp_secret does not
 * exist`, which the response could not say and the silenced logger swallowed.
 */
const logLines: string[] = [];

async function staffAccount(role: StaffRole): Promise<{ id: string; token: string }> {
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
  return { id, token: issued.token };
}

const send = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  ({ id: adminId, token: adminToken } = await staffAccount('administrator'));
});

afterEach(() => {
  // Any 500 is a defect, and one that only shows up as a status code costs an
  // hour of bisecting. Surfaced the moment it happens, with the server's own
  // reason attached.
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  if (failures.length > 0) {
    throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
  }
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('creating a staff account', () => {
  it('creates one, with roles, and reports it as Pending until it is claimed', async () => {
    const response = await send('POST', '/staff/users', adminToken, {
      email: 'new.evaluator@lgu.gov.ph', roles: ['evaluator'],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; status: string; roles: string[]; nextStep: string }>();
    expect(body.status).toBe('Pending');
    expect(body.roles).toEqual(['evaluator']);
    expect(body.nextStep).toMatch(/password/i);
  });

  it('SETS NO PASSWORD, so the administrator cannot sign in as the officer', async () => {
    // The rule the whole design rests on. An administrator who can set a
    // password can act as that officer, and every audit entry the account then
    // writes names someone who did not perform the act.
    const created = await send('POST', '/staff/users', adminToken, {
      email: 'no.password@lgu.gov.ph', roles: ['records-officer'],
    });
    expect(created.statusCode).toBe(201);

    const stored = await db.query<{ password_hash: string }>(
      "select password_hash from accounts where email_normalised = 'no.password@lgu.gov.ph'",
    );
    const hash = stored.rows[0]?.password_hash ?? '';
    // Well-formed, so `verify` runs its full comparison rather than meeting a
    // sentinel some future branch might read as "no password set".
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{32}$/);

    // And nothing can sign in with it. There is no plaintext that produces it.
    const attempt = await app.inject({
      method: 'POST', url: '/auth/token',
      payload: { email: 'no.password@lgu.gov.ph', password: 'whatever-they-guess' },
    });
    expect(attempt.statusCode).not.toBe(200);
  });

  it('refuses an address that already exists', async () => {
    await send('POST', '/staff/users', adminToken, { email: 'twice@lgu.gov.ph', roles: [] });
    const again = await send('POST', '/staff/users', adminToken, { email: 'TWICE@lgu.gov.ph', roles: [] });

    // Normalised, so the same address in different case is the same account.
    expect(again.statusCode).toBe(409);
  });

  it('refuses a role that is not in the role table', async () => {
    const response = await send('POST', '/staff/users', adminToken, {
      email: 'invented.role@lgu.gov.ph', roles: ['Chief Vibes Officer'],
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('the escalation rules, which hold each other up', () => {
  it('refuses an administrator changing THEIR OWN roles', async () => {
    // Without this, staff:administer is every scope, one request away.
    const response = await send('POST', `/staff/users/${adminId}/roles`, adminToken, {
      roles: ['administrator', 'building-official'],
    });

    expect(response.statusCode).toBe(403);
    const after = await db.query<{ role: string }>(
      'select role from account_roles where account_id = $1', [adminId],
    );
    expect(after.rows.map((r) => r.role)).toEqual(['administrator']);
  });

  it('refuses an administrator disabling their own account', async () => {
    // Not a security rule so much as a locked-door rule, but the same shape.
    const response = await send('POST', `/staff/users/${adminId}/disable`, adminToken, {});

    expect(response.statusCode).toBe(403);
  });

  it('lets an administrator role SOMEONE ELSE, which is the point of the screen', async () => {
    // The control. Without it, the two refusals above pass just as well if the
    // endpoint is broken for everyone.
    const other = await staffAccount('evaluator');
    const response = await send('POST', `/staff/users/${other.id}/roles`, adminToken, {
      roles: ['evaluator', 'receiving-officer'],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ roles: string[] }>().roles.sort()).toEqual(['evaluator', 'receiving-officer']);
  });

  it('grants an MFA-required role that cannot be used until MFA is enrolled', async () => {
    // The proxy route round the self-escalation rule: create an account holding
    // staff:approve and use it. It is closed twice — no password can be set,
    // and `verifyTotp` fails closed with no secret enrolled.
    const created = await send('POST', '/staff/users', adminToken, {
      email: 'approver@lgu.gov.ph', roles: ['building-official'],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json<{ mfaRequired: boolean; mfaEnrolled: boolean }>();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaEnrolled).toBe(false);
  });

  it('refuses every one of these to a role without staff:administer', async () => {
    const evaluator = await staffAccount('evaluator');
    const victim = await staffAccount('cashier');

    expect((await send('GET', '/staff/users', evaluator.token)).statusCode).toBe(403);
    expect((await send('POST', '/staff/users', evaluator.token, {
      email: 'sneaky@lgu.gov.ph', roles: ['administrator'],
    })).statusCode).toBe(403);
    expect((await send('POST', `/staff/users/${victim.id}/roles`, evaluator.token, {
      roles: ['administrator'],
    })).statusCode).toBe(403);
  });
});

describe('disabling an account', () => {
  it('disables it, and the standing check stops the next request it makes', async () => {
    const victim = await staffAccount('evaluator');
    // It works before.
    expect((await send('GET', '/staff/applications', victim.token)).statusCode).toBe(200);

    const disabled = await send('POST', `/staff/users/${victim.id}/disable`, adminToken, {
      reason: 'Offboarded on 27 August.',
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ status: string }>().status).toBe('Disabled');

    // And stops immediately after — not when the access token expires. The
    // token is still perfectly valid and still signed; standing is what refuses.
    expect((await send('GET', '/staff/applications', victim.token)).statusCode).toBe(401);
  });

  it('enables it again, and the same token works once more', async () => {
    const victim = await staffAccount('evaluator');
    await send('POST', `/staff/users/${victim.id}/disable`, adminToken, {});
    expect((await send('GET', '/staff/applications', victim.token)).statusCode).toBe(401);

    await send('POST', `/staff/users/${victim.id}/enable`, adminToken);

    expect((await send('GET', '/staff/applications', victim.token)).statusCode).toBe(200);
  });

  it('writes an audit entry naming the administrator, not the account', async () => {
    const victim = await staffAccount('cashier');
    await send('POST', `/staff/users/${victim.id}/disable`, adminToken, { reason: 'Suspected fraud.' });

    const audit = await db.query<{ actor_account_id: string; subject_id: string; after_state: { reason: string } }>(
      `select actor_account_id, subject_id, after_state from audit_events
        where action = 'staff.account.disabled' order by sequence desc limit 1`,
    );
    expect(audit.rows[0]?.actor_account_id).toBe(adminId);
    expect(audit.rows[0]?.subject_id).toBe(victim.id);
    expect(audit.rows[0]?.after_state.reason).toBe('Suspected fraud.');
  });
});

describe('sessions', () => {
  it('lists a signed-in officer as one session, not one per refresh', async () => {
    // A session is a refresh-token FAMILY. Counting rows would report one
    // laptop as a dozen sessions after a day of rotation.
    const officer = await staffAccount('evaluator');
    const family = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at)
         values ($1,$2,$3,'digest', now(), now() + interval '30 days')`,
        [randomUUID(), family, officer.id],
      );
    }

    const response = await send('GET', `/staff/users/${officer.id}/sessions`, adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('revokes one, and the access token carrying that sid stops working', async () => {
    const officer = await staffAccount('evaluator');
    const family = randomUUID();
    await db.query(
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at)
       values ($1,$2,$3,'digest', now(), now() + interval '30 days')`,
      [randomUUID(), family, officer.id],
    );
    const issued = await tokens.issueAccessToken({
      sub: officer.id, sid: family, kind: 'staff',
      scopes: [...scopesFor({ kind: 'staff', roles: ['evaluator'] })],
    });
    expect((await send('GET', '/staff/applications', issued.token)).statusCode).toBe(200);

    const revoked = await send('DELETE', `/staff/users/${officer.id}/sessions/${family}`, adminToken);

    expect(revoked.statusCode).toBe(204);
    expect((await send('GET', '/staff/applications', issued.token)).statusCode).toBe(401);
    // And it is gone from the list.
    expect((await send('GET', `/staff/users/${officer.id}/sessions`, adminToken))
      .json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('refuses to revoke a session that belongs to a different account', async () => {
    // Checked against the owner rather than the family id alone: otherwise a
    // guessed id revokes anyone's session and the audit entry names the wrong
    // subject.
    const owner = await staffAccount('evaluator');
    const other = await staffAccount('cashier');
    const family = randomUUID();
    await db.query(
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at)
       values ($1,$2,$3,'digest', now(), now() + interval '30 days')`,
      [randomUUID(), family, owner.id],
    );

    const response = await send('DELETE', `/staff/users/${other.id}/sessions/${family}`, adminToken);

    expect(response.statusCode).toBe(404);
    // Asserted on THIS family, not on the table's row count -- an earlier test
    // in this file revokes a session of its own, and a global count would have
    // been measuring that instead.
    const revocations = await db.query<{ n: string }>(
      'select count(*) as n from revoked_sessions where family_id = $1', [family],
    );
    expect(Number(revocations.rows[0]?.n)).toBe(0);
  });
});

describe('changing an address', () => {
  it('refuses, and says why, rather than 404ing as though the URL were wrong', async () => {
    const officer = await staffAccount('evaluator');
    const response = await send('PATCH', `/staff/users/${officer.id}`, adminToken, {
      email: 'renamed@lgu.gov.ph',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toMatch(/re-verification/i);
  });
});
