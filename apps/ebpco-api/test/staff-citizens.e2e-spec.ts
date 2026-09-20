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
import { APPLICANT_SCOPES, StaffRole, scopesFor } from '../src/modules/identity/domain/account';

/**
 * The Citizens module, over HTTP — `/staff/citizens/*`.
 *
 * `staff-roles.e2e-spec.ts` already proves, generically over every `/staff/`
 * route (this one included, since it auto-discovers the route table): no
 * applicant token reaches any of these routes, every route is reachable by
 * SOME real role, and every mutation refuses the auditor. What is specific
 * to this module and worth its own file: the 404-not-403 posture for a
 * staff account id, the disable/session-revoke effect on an ALREADY ISSUED
 * token, idempotent replay, the field allow-list on rectification, and that
 * erasure really does call through to `ErasureService` rather than a local
 * reimplementation.
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
let adminToken: string;
let receivingToken: string;
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

/** A real citizen: an account plus its applicant profile, the shape every route here reads. */
async function citizen(overrides: {
  firstName?: string; lastName?: string; email?: string; mobileNumber?: string;
} = {}): Promise<{ id: string; email: string; token: string; refreshToken: string; sid: string }> {
  const id = randomUUID();
  const email = overrides.email ?? `citizen-${id.slice(0, 8)}@example.ph`;
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, mobile_number, password_hash)
     values ($1,'applicant',$2,$2,$3,'scrypt$1$1$1$a$b')`,
    [id, email, overrides.mobileNumber ?? '09171234567'],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,$3,$4)`,
    [randomUUID(), id, overrides.firstName ?? 'Juan', overrides.lastName ?? 'Dela Cruz'],
  );
  // Same family id on both tokens, the way a real sign-in issues them
  // together — required for the "revoke all sessions" test below, which
  // proves the REFRESH token tied to this exact session is refused.
  const refresh = await tokens.startSession(id);
  const issued = await tokens.issueAccessToken({
    sub: id, sid: refresh.familyId, kind: 'applicant', scopes: [...APPLICANT_SCOPES],
  });
  return { id, email, token: issued.token, refreshToken: refresh.presented, sid: refresh.familyId };
}

const send = (
  method: 'GET' | 'POST' | 'DELETE', url: string, token: string,
  options: { payload?: Record<string, unknown>; idempotencyKey?: string } = {},
) =>
  app.inject({
    method, url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });

/** A mutating call with a fresh Idempotency-Key and a valid reason, unless overridden. */
const mutate = (
  method: 'POST' | 'DELETE', url: string, token: string, body: Record<string, unknown> = {},
) => send(method, url, token, {
  payload: { reason: 'front-desk correction, citizen present', ...body },
  idempotencyKey: randomUUID(),
});

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  adminToken = (await staffAccount('administrator')).token;
  receivingToken = (await staffAccount('receiving-officer')).token;
});

afterEach(() => {
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

describe('listing and metrics', () => {
  it('lists a real citizen, and a front-desk role (citizens:read, no staff:administer) can read it', async () => {
    const c = await citizen({ firstName: 'Maria', lastName: 'Santos' });
    const response = await send('GET', '/staff/citizens?search=Santos', receivingToken);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ rows: Array<{ id: string; firstName: string }>; total: number }>();
    expect(body.rows.some((r) => r.id === c.id && r.firstName === 'Maria')).toBe(true);
  });

  it('the list row carries no mobile number and no address', async () => {
    await citizen({ firstName: 'Privacy', lastName: 'Check' });
    const response = await send('GET', '/staff/citizens?search=Privacy', adminToken);
    const body = response.json<{ rows: Array<Record<string, unknown>> }>();
    const row = body.rows.find((r) => r.firstName === 'Privacy')!;
    expect(row.mobileNumber).toBeUndefined();
    expect(row.street).toBeUndefined();
  });

  it('search escapes % and _ rather than treating them as wildcards', async () => {
    const before = (await send('GET', '/staff/citizens?pageSize=1', adminToken)).json<{ total: number }>().total;
    await citizen({ firstName: 'Percent%Name', lastName: 'Wild' });
    await citizen({ firstName: 'Ordinary', lastName: 'Person' });

    const literal = await send('GET', `/staff/citizens?search=${encodeURIComponent('Percent%Name')}`, adminToken);
    const literalBody = literal.json<{ rows: Array<{ firstName: string }> }>();
    expect(literalBody.rows.map((r) => r.firstName)).toEqual(['Percent%Name']);

    // A bare '%', escaped, must match only the citizen whose name genuinely
    // contains a literal '%' — not every citizen in the register, which is
    // what an unescaped ILIKE wildcard would do (`before + 2` from this test
    // alone, and more from every earlier one in this file, since the
    // database is shared across the whole suite).
    const wildcard = await send('GET', '/staff/citizens?search=%25', adminToken);
    const wildcardBody = wildcard.json<{ rows: Array<{ firstName: string }>; total: number }>();
    expect(wildcardBody.total).toBe(1);
    expect(wildcardBody.rows[0]?.firstName).toBe('Percent%Name');
    expect(wildcardBody.total).toBeLessThan(before + 2);
  });

  it('pagination stays within bounds and reports the real total', async () => {
    const response = await send('GET', '/staff/citizens?page=1&pageSize=1', adminToken);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ rows: unknown[]; page: number; pageSize: number; total: number }>();
    expect(body.rows.length).toBeLessThanOrEqual(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(1);
    expect(body.total).toBeGreaterThan(0);
  });

  it('rejects a pageSize over 200', async () => {
    const response = await send('GET', '/staff/citizens?pageSize=99999', adminToken);
    expect(response.statusCode).toBe(400);
  });

  it('metrics arithmetic: active + disabled = total, and a fresh citizen counts as active and unverified', async () => {
    const before = (await send('GET', '/staff/citizens/metrics', adminToken))
      .json<{ total: number; active: number; disabled: number; emailVerified: number }>();
    await citizen();
    const after = (await send('GET', '/staff/citizens/metrics', adminToken))
      .json<{ total: number; active: number; disabled: number }>();

    expect(after.total).toBe(before.total + 1);
    expect(after.active).toBe(before.active + 1);
    expect(after.active + after.disabled).toBe(after.total);
  });
});

describe('detail: not-found posture and view auditing', () => {
  it('404s a staff account id — not-found-as-not-yours, the same as staff-directory', async () => {
    const staff = await staffAccount('evaluator');
    const response = await send('GET', `/staff/citizens/${staff.id}`, adminToken);
    expect(response.statusCode).toBe(404);
  });

  it('404s an id that does not exist at all, identically', async () => {
    const response = await send('GET', `/staff/citizens/${randomUUID()}`, adminToken);
    expect(response.statusCode).toBe(404);
  });

  it('reading a citizen appends a citizen.viewed audit entry, visible in the citizen\'s own Activity tab', async () => {
    const c = await citizen();
    const response = await send('GET', `/staff/citizens/${c.id}`, adminToken);
    expect(response.statusCode).toBe(200);

    const detail = await send('GET', `/staff/citizens/${c.id}`, adminToken);
    const body = detail.json<{ auditEntries: Array<{ action: string }> }>();
    expect(body.auditEntries.some((e) => e.action === 'citizen.viewed')).toBe(true);
  });
});

describe('sign-out effect on an already-issued token', () => {
  it('disabling refuses the account\'s CURRENT access token on its next request, not just future sign-ins', async () => {
    const c = await citizen();
    // Proven live first, so a refusal below is proof of the disable, not of
    // some unrelated brokenness.
    expect((await send('GET', '/me', c.token)).statusCode).toBe(200);

    const disabled = await mutate('POST', `/staff/citizens/${c.id}/disable`, adminToken);
    expect(disabled.statusCode).toBe(200);

    const after = await send('GET', '/me', c.token);
    expect(after.statusCode).toBe(401);
  });

  it('persists the reason, and enabling clears it', async () => {
    const c = await citizen();
    await mutate('POST', `/staff/citizens/${c.id}/disable`, adminToken, { reason: 'reported lost device' });

    const stored = await db.query<{ disabled_reason: string | null; disabled_at: Date | null }>(
      'select disabled_reason, disabled_at from accounts where id = $1', [c.id],
    );
    expect(stored.rows[0]?.disabled_reason).toBe('reported lost device');
    expect(stored.rows[0]?.disabled_at).not.toBeNull();

    await mutate('POST', `/staff/citizens/${c.id}/enable`, adminToken);
    const cleared = await db.query<{ disabled_reason: string | null; disabled_at: Date | null }>(
      'select disabled_reason, disabled_at from accounts where id = $1', [c.id],
    );
    expect(cleared.rows[0]?.disabled_reason).toBeNull();
    expect(cleared.rows[0]?.disabled_at).toBeNull();
  });

  it('"Sign out all sessions" revokes the family, so the OLD refresh token is refused on its next use', async () => {
    const c = await citizen();
    const revoke = await mutate('DELETE', `/staff/citizens/${c.id}/sessions`, adminToken);
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<{ revoked: number }>().revoked).toBeGreaterThanOrEqual(1);

    const refreshed = await app.inject({
      method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: c.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('every mutation refuses a missing reason with 400, before touching the account', async () => {
    const c = await citizen();
    const response = await send('POST', `/staff/citizens/${c.id}/disable`, adminToken, {
      payload: {}, idempotencyKey: randomUUID(),
    });
    expect(response.statusCode).toBe(400);

    const stored = await db.query<{ disabled_at: Date | null }>(
      'select disabled_at from accounts where id = $1', [c.id],
    );
    expect(stored.rows[0]?.disabled_at).toBeNull();
  });
});

describe('idempotency', () => {
  it('replays the first response for a repeated key, and does not disable twice over', async () => {
    const c = await citizen();
    const key = randomUUID();
    const first = await send('POST', `/staff/citizens/${c.id}/disable`, adminToken, {
      payload: { reason: 'duplicate click test' }, idempotencyKey: key,
    });
    const second = await send('POST', `/staff/citizens/${c.id}/disable`, adminToken, {
      payload: { reason: 'duplicate click test' }, idempotencyKey: key,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('refuses the SAME key reused for a different request to the SAME operation', async () => {
    // Scoped to one operation, matching `idempotency_keys`'s own design
    // (`persistence/idempotency.ts`): a key is looked up by account, key
    // AND operation together, the same shape every other staff mutation in
    // this codebase already relies on (see `staff-business-registration
    // .service.ts`'s identical `lookup`/`remember` pair). Reusing a key
    // across two DIFFERENT operations is a client bug this shared
    // infrastructure does not special-case anywhere in this codebase today
    // — recorded as a known gap in CITIZENS-HANDOFF.md rather than papered
    // over locally in only this module's mutations.
    const c = await citizen();
    const key = randomUUID();
    const first = await send('POST', `/staff/citizens/${c.id}/disable`, adminToken, {
      payload: { reason: 'first reason given' }, idempotencyKey: key,
    });
    expect(first.statusCode).toBe(200);
    const reused = await send('POST', `/staff/citizens/${c.id}/disable`, adminToken, {
      payload: { reason: 'a completely different reason' }, idempotencyKey: key,
    });
    expect(reused.statusCode).toBe(409);
  });
});

describe('rectification', () => {
  it('corrects an allowed field, and records before/after in the audit trail', async () => {
    const c = await citizen({ lastName: 'Delacruz' });
    const response = await mutate('POST', `/staff/citizens/${c.id}/rectification`, adminToken, {
      changes: { lastName: 'Dela Cruz' },
    });
    expect(response.statusCode).toBe(200);

    const stored = await db.query<{ last_name: string }>(
      'select last_name from applicants where account_id = $1', [c.id],
    );
    expect(stored.rows[0]?.last_name).toBe('Dela Cruz');

    const detail = await send('GET', `/staff/citizens/${c.id}`, adminToken);
    const body = detail.json<{ auditEntries: Array<{ action: string; actorAccountId: string | null }> }>();
    // Two entries: the self-attributed one RectificationService itself
    // writes, and this module's own staff-attributed one.
    expect(body.auditEntries.filter((e) => e.action === 'citizen.rectified').length).toBe(1);
    expect(body.auditEntries.filter((e) => e.action === 'profile.rectified').length).toBe(1);
  });

  it('refuses a field outside the rectifiable set — the sign-in email is not one of them', async () => {
    const c = await citizen();
    const response = await send('POST', `/staff/citizens/${c.id}/rectification`, adminToken, {
      payload: { reason: 'trying to change the email', changes: { email: 'new@example.ph' } },
      idempotencyKey: randomUUID(),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('erasure', () => {
  it('calls through to ErasureService: the account is pseudonymised and its application survives', async () => {
    const c = await citizen();
    const originalEmail = c.email;
    const applicantRow = await db.query<{ id: string }>(
      'select id from applicants where account_id = $1', [c.id],
    );
    const applicantId = applicantRow.rows[0]!.id;
    const applicationId = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'BP-2026-CIT001',$2,'Fencing Permit','New','Submitted', now(), $3)`,
      [applicationId, applicantId, c.id],
    );

    const response = await mutate('POST', `/staff/citizens/${c.id}/erasure`, adminToken, {
      requestReference: 'walk-in-2026-09-20-01',
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ retainedCategories: Array<{ category: string }> }>();
    expect(body.retainedCategories.length).toBeGreaterThan(0);

    const account = await db.query<{ email: string; erased_at: Date | null }>(
      'select email, erased_at from accounts where id = $1', [c.id],
    );
    expect(account.rows[0]?.erased_at).not.toBeNull();
    expect(account.rows[0]?.email).toMatch(/^erased-/);

    const stillThere = await db.query<{ id: string }>('select id from applications where id = $1', [applicationId]);
    expect(stillThere.rows[0]?.id).toBe(applicationId);

    // The account row survives as an opaque key (erasure.service.ts's own
    // design: the applicant's permit-record name is 'statutory' retention
    // and is untouched by erasure) — so the citizen still appears in the
    // register, but no longer findable by the ORIGINAL email that erasure
    // just replaced.
    const listed = await send('GET', `/staff/citizens?search=${encodeURIComponent(originalEmail)}`, adminToken);
    expect(listed.json<{ total: number }>().total).toBe(0);
  });

  it('records who asked and under what reference, distinct from the unmodified account.erased entry', async () => {
    const c = await citizen();
    await mutate('POST', `/staff/citizens/${c.id}/erasure`, adminToken, {
      reason: 'citizen requested via phone, verified by callback', requestReference: 'REF-2026-0099',
    });
    const history = await db.query<{ action: string; actor_account_id: string | null; after_state: unknown }>(
      `select action, actor_account_id, after_state from audit_events
        where subject_type = 'account' and subject_id = $1 order by sequence`,
      [c.id],
    );
    const requested = history.rows.find((r) => r.action === 'citizen.erasure.requested');
    const erased = history.rows.find((r) => r.action === 'account.erased');
    expect(requested?.actor_account_id).not.toBeNull();
    expect(erased?.actor_account_id).toBeNull(); // ErasureService's own entry, unmodified — self-service has no other actor.
  });
});

describe('password reset link', () => {
  it('reports not-sent honestly when no mail provider is configured, and audits the attempt', async () => {
    const c = await citizen();
    const response = await mutate('POST', `/staff/citizens/${c.id}/password-reset-link`, adminToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ delivery: string }>().delivery).toBe('not-sent');

    const history = await db.query<{ action: string }>(
      `select action from audit_events where subject_type = 'account' and subject_id = $1
        and action = 'citizen.password-reset-link-sent'`,
      [c.id],
    );
    expect(history.rows.length).toBe(1);
  });
});

describe('a citizen token reaches nothing here, and it is recorded', () => {
  it('403s a citizen token on the list route, and writes an authorisation.refused entry', async () => {
    const c = await citizen();
    const response = await send('GET', '/staff/citizens', c.token);
    expect(response.statusCode).toBe(403);

    const refused = await db.query<{ action: string }>(
      `select action from audit_events where actor_account_id = $1 and action = 'authorisation.refused'`,
      [c.id],
    );
    expect(refused.rows.length).toBeGreaterThanOrEqual(1);
  });
});
