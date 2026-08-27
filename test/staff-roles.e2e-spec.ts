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
import {
  APPLICANT_SCOPES, PORTAL_ROLE_LABELS, ROLE_SCOPES, StaffRole, scopesFor,
} from '../src/modules/identity/domain/account';

/**
 * WP-01 / TAB 00 — the role table, proved against the real route table.
 *
 * The web portal and this service grew separate role vocabularies, and this is
 * where the reconciliation is checked rather than asserted. Two failures are
 * being guarded against, and they point in opposite directions:
 *
 *   1. A STAFF ROUTE NO REAL ROLE CAN REACH. This has already happened once:
 *      three lifecycle transitions required a scope no role granted, so the
 *      rules were unsatisfiable by any actual officer. No individual test
 *      caught it, because each was written against a caller holding every
 *      scope — which is exactly the caller that does not exist in production.
 *
 *   2. A ROLE REACHING A ROUTE IT SHOULD NOT. Specifically the auditor, whose
 *      entire definition is oversight without authority. A read-only role that
 *      can write is not a weaker version of the feature; it is the absence of
 *      it.
 *
 * Both are asserted over the routes the SERVER reports, not a list kept here,
 * so a route added tomorrow is covered today.
 */

const ENV: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

const ALL_ROLES = Object.keys(ROLE_SCOPES) as StaffRole[];

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let routes: string[];
const tokenByRole = new Map<StaffRole, string>();

async function mint(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  // Through the real table, which is also what proves migration 016 accepts
  // the two new roles: a check constraint refuses them otherwise.
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  const issued = await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff',
    scopes: [...scopesFor({ kind: 'staff', roles: [role] })],
  });
  return issued.token;
}

/** Probe a route with a token, returning the status. Payloads are deliberately empty. */
const probe = async (route: string, token: string): Promise<number> => {
  const [method, path] = route.split(' ');
  const response = await app.inject({
    method: method as 'GET',
    url: (path ?? '/').replace(/:(\w+)/g, randomUUID()),
    headers: { authorization: `Bearer ${token}` },
    ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {}, headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(),
    } }),
  });
  return response.statusCode;
};

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);

  // Collected as Fastify registers each route, not parsed from printRoutes():
  // an earlier test parsed that output and silently checked `/refresh` instead
  // of `/auth/token/refresh`, which is worse than no coverage test at all.
  routes = [];
  app.getHttpAdapter().getInstance().addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push(`${method} ${route.url}`);
    }
  });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  for (const role of ALL_ROLES) tokenByRole.set(role, await mint(role));
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the role table and the route table agree', () => {
  it('enumerates enough to be meaningful', () => {
    // A test that enumerates nothing passes vacuously.
    expect(ALL_ROLES.length).toBeGreaterThanOrEqual(10);
    expect(routes.filter((r) => r.includes(' /staff/')).length).toBeGreaterThan(5);
  });

  it('gives every role a portal-facing label, and no label a role that does not exist', () => {
    // The reconciliation itself. Two lists that must not drift.
    expect(Object.keys(PORTAL_ROLE_LABELS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it('leaves no staff route unreachable by every real role', async () => {
    // The failure this exists for: a route whose required scope no role grants.
    // 403 means authorisation refused; anything else means the caller got past
    // it, including a 404 or a 400 from an empty payload, which is what a probe
    // against a random id is expected to produce.
    const unreachable: string[] = [];

    for (const route of routes.filter((r) => r.includes(' /staff/'))) {
      const statuses = await Promise.all(
        ALL_ROLES.map(async (role) => probe(route, tokenByRole.get(role)!)),
      );
      if (statuses.every((status) => status === 403)) unreachable.push(route);
    }

    expect(unreachable).toEqual([]);
  });

  /**
   * Routes whose guard is deliberately coarse, so a scope probe cannot answer
   * the question. `transitions` requires only `applications:read` on purpose --
   * WHICH move a caller may make is decided per transition by the lifecycle
   * engine, which is the only layer that knows what is being moved and from
   * where. A probe against a random id therefore 404s before authorisation is
   * ever consulted, and reading that 404 as "allowed" would be false.
   *
   * These are not exempt. They are asserted below against a REAL application,
   * which is the only honest way to ask the question.
   */
  const ENGINE_AUTHORISED = new Set(['POST /staff/applications/:applicationId/transitions']);

  it('refuses the auditor every staff route whose guard can answer', async () => {
    // Oversight without authority. If this ever passes something, the role has
    // stopped being read-only and the portal's Auditor screen is a lie.
    const auditor = tokenByRole.get('auditor')!;
    const allowed: string[] = [];

    for (const route of routes.filter((r) => r.includes(' /staff/'))) {
      const [method] = route.split(' ');
      if (method === 'GET' || ENGINE_AUTHORISED.has(route)) continue;
      if (await probe(route, auditor) !== 403) allowed.push(route);
    }

    expect(allowed).toEqual([]);
    // The exemption list must not quietly grow to cover everything.
    expect(ENGINE_AUTHORISED.size).toBeLessThan(3);
  });

  it('refuses the auditor a real transition on a real application', async () => {
    // The coarse-guard route, asked properly. A 404 against a random id proves
    // nothing; this application exists, the move is legal, and the only thing
    // standing between the auditor and it is authorisation.
    const account = randomUUID();
    const applicant = randomUUID();
    const application = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','auditor-probe@example.ph','auditor-probe@example.ph','scrypt$1$1$1$a$b')`,
      [account],
    );
    await db.query(
      `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
      [applicant, account],
    );
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'BP-2026-090909',$2,'Fencing','New','Submitted', now(), $3)`,
      [application, applicant, account],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/staff/applications/${application}/transitions`,
      headers: {
        authorization: `Bearer ${tokenByRole.get('auditor')!}`,
        'idempotency-key': randomUUID(),
      },
      payload: { to: 'Received' },
    });

    expect(response.statusCode).not.toBe(200);
    // And the record did not move, which is the fact that actually matters --
    // a refusal that still wrote would be the worst of both.
    const after = await db.query<{ lifecycle_status: string }>(
      'select lifecycle_status from applications where id = $1', [application],
    );
    expect(after.rows[0]?.lifecycle_status).toBe('Submitted');
  });

  it('lets a receiving officer make that same transition, so the test above proves refusal and not breakage', async () => {
    // Without this, the assertion above passes just as well if the route is
    // broken for everyone.
    const account = randomUUID();
    const applicant = randomUUID();
    const application = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','control-probe@example.ph','control-probe@example.ph','scrypt$1$1$1$a$b')`,
      [account],
    );
    await db.query(
      `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Jose','Rizal')`,
      [applicant, account],
    );
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'BP-2026-090910',$2,'Fencing','New','Submitted', now(), $3)`,
      [application, applicant, account],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/staff/applications/${application}/transitions`,
      headers: {
        authorization: `Bearer ${tokenByRole.get('records-officer')!}`,
        'idempotency-key': randomUUID(),
      },
      payload: { to: 'Received' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('lets NO applicant token reach any /staff route', async () => {
    // A whole class of bug, closed once. An applicant holds `applications:read`,
    // `documents:read` and `payments:read` — the same scopes most staff read
    // routes require — so scope alone never separated the two populations. The
    // existing staff routes survived only because their services re-checked;
    // `/staff/businesses` did not, and answered an applicant with every business
    // in the LGU, owners' addresses and mobile numbers included.
    const account = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','applicant-probe@example.ph','applicant-probe@example.ph','scrypt$1$1$1$a$b')`,
      [account],
    );
    const issued = await tokens.issueAccessToken({
      sub: account, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
    });

    const reached: string[] = [];
    for (const route of routes.filter((r) => r.includes(' /staff/'))) {
      const status = await probe(route, issued.token);
      if (status !== 403) reached.push(`${route} -> ${status}`);
    }

    expect(reached).toEqual([]);
  });

  it('refuses the super-admin the four acting scopes, deliberately', () => {
    // Seeing every screen is not being able to perform every act. Asserted on
    // the table rather than over HTTP because it is a statement about what the
    // role IS, and it must hold before any route exists to test it against.
    const granted = new Set(scopesFor({ kind: 'staff', roles: ['super-admin'] }));

    for (const scope of ['staff:assess', 'staff:verify-payment', 'staff:approve', 'staff:release']) {
      expect(granted.has(scope as never)).toBe(false);
    }
    expect(granted.has('staff:administer')).toBe(true);
    expect(granted.has('audit:read')).toBe(true);
  });

  it('grants the auditor no write scope of any kind', () => {
    const granted = scopesFor({ kind: 'staff', roles: ['auditor'] });
    // `profile:write` is granted to every account -- managing your own record
    // is not a job function, so it is not evidence of authority over others.
    const overOthers = granted.filter((scope) => scope.includes(':write') && !scope.startsWith('profile:'));

    expect(overOthers).toEqual([]);
    expect(granted).toContain('audit:read');
  });
});
