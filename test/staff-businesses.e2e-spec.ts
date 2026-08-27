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
 * TAB 02 — the LGU's business directory, as an officer sees it.
 *
 * The assertion that matters most is the separation from `GET /businesses`.
 * That route is scoped to the caller's own applicant row, so an officer calling
 * it gets an EMPTY LIST rather than an error — a failure that looks like an
 * answer, which is the worst kind.
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

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let officerToken: string;
let mariaBusiness: string;
let joseBusiness: string;
let mariaApplicantId: string;
let mariaAccount: string;
const logLines: string[] = [];

async function staffToken(role: StaffRole): Promise<string> {
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

async function applicantWithBusiness(options: {
  first: string; last: string; email: string; mobile: string | null;
  business: string; category: string; registration: string; status?: string;
}): Promise<{ accountId: string; applicantId: string; businessId: string }> {
  const accountId = randomUUID();
  const applicantId = randomUUID();
  const businessId = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number)
     values ($1,'applicant',$2,$2,'scrypt$1$1$1$a$b',$3)`,
    [accountId, options.email, options.mobile],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,$3,$4)`,
    [applicantId, accountId, options.first, options.last],
  );
  await db.query(
    `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                             province, registration_number, date_registered, status)
     values ($1,$2,$3,$4,'12 Rizal Street','Poblacion','Castilla','Sorsogon',$5,'2024-03-01',$6)`,
    [businessId, applicantId, options.business, options.category, options.registration,
     options.status ?? 'Active'],
  );
  return { accountId, applicantId, businessId };
}

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  officerToken = await staffToken('receiving-officer');

  const maria = await applicantWithBusiness({
    first: 'Maria', last: 'Santos', email: 'maria@example.ph', mobile: '+639171234567',
    business: 'Santos Sari-Sari Store', category: 'Retail', registration: 'BN-2024-0001',
  });
  mariaBusiness = maria.businessId;
  mariaApplicantId = maria.applicantId;
  mariaAccount = maria.accountId;

  const jose = await applicantWithBusiness({
    first: 'Jose', last: 'Rizal', email: 'jose@example.ph', mobile: null,
    business: 'Rizal Hardware', category: 'Wholesale', registration: 'BN-2024-0002',
    status: 'Inactive',
  });
  joseBusiness = jose.businessId;

  await db.query(
    `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                               application_action, lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000101',$2,$3,'Fencing','New','Submitted', now(), $4)`,
    [randomUUID(), mariaApplicantId, mariaBusiness, mariaAccount],
  );
});

afterEach(() => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the officer route is not the applicant route', () => {
  it('shows an officer EVERY business, not their own none', async () => {
    const response = await app.inject({
      method: 'GET', url: '/staff/businesses',
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const names = response.json<{ data: { name: string }[] }>().data.map((b) => b.name);
    expect(names).toEqual(['Rizal Hardware', 'Santos Sari-Sari Store']);
  });

  it('answers an officer on GET /businesses with 200 AND AN EMPTY LIST, which is why this route exists', async () => {
    // The reason for the separation, measured rather than assumed — and it is
    // worse than "the applicant route refuses an officer", which is what the
    // Master Command claimed before this test was written.
    //
    // `profile:read` is granted to EVERY account, not by any role: managing
    // your own record is not a job function. So an officer calling the
    // applicant route passes the scope guard, and the query then filters to
    // their own applicant row, which an officer does not have. The result is a
    // 200 carrying `[]` — an empty answer indistinguishable from "this LGU has
    // no registered businesses".
    //
    // That is not a bug in this route. An officer may legitimately BE an
    // applicant — staff apply for permits on their own houses, which the
    // evaluation self-review rule already accounts for — so returning their own
    // businesses is correct. It is simply a different question from the one the
    // Businesses screen asks, which is what /staff/businesses answers.
    const response = await app.inject({
      method: 'GET', url: '/businesses',
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('still scopes the applicant route to the applicant, who sees only their own', async () => {
    const issued = await tokens.issueAccessToken({
      sub: mariaAccount, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
    });
    const response = await app.inject({
      method: 'GET', url: '/businesses', headers: { authorization: `Bearer ${issued.token}` },
    });

    expect(response.json<{ data: { name: string }[] }>().data.map((b) => b.name))
      .toEqual(['Santos Sari-Sari Store']);
  });

  it('refuses an applicant the staff route outright', async () => {
    const issued = await tokens.issueAccessToken({
      sub: mariaAccount, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
    });
    const response = await app.inject({
      method: 'GET', url: '/staff/businesses', headers: { authorization: `Bearer ${issued.token}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('what a row carries', () => {
  it('names the owner and the way to reach them, from the real applicant row', async () => {
    const response = await app.inject({
      method: 'GET', url: `/staff/businesses/${mariaBusiness}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      name: 'Santos Sari-Sari Store',
      category: 'Retail',
      registrationNumber: 'BN-2024-0001',
      dateRegistered: '2024-03-01',
      status: 'Active',
      owner: {
        applicantId: mariaApplicantId,
        name: 'Maria Santos',
        email: 'maria@example.ph',
        mobileNumber: '+639171234567',
      },
    });
  });

  it('carries no column the next migration might add', async () => {
    // The select-star guard, asserted rather than trusted to the comment. A
    // column added to `businesses`, `applicants` or `accounts` must not appear
    // here by default — this route reaches every business in the LGU, so a
    // default disclosure is about people the caller has no relationship with.
    const response = await app.inject({
      method: 'GET', url: `/staff/businesses/${mariaBusiness}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      'applicationCount', 'applications', 'barangay', 'category', 'city', 'createdAt',
      'dateRegistered', 'id', 'name', 'owner', 'province', 'registrationNumber', 'status', 'street',
    ]);
  });

  it('never leaks the owner account id or password hash through the join', async () => {
    const response = await app.inject({
      method: 'GET', url: '/staff/businesses',
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('scrypt');
    expect(response.body).not.toContain(mariaAccount);
  });

  it('links the applications that genuinely name this business', async () => {
    const response = await app.inject({
      method: 'GET', url: `/staff/businesses/${mariaBusiness}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });

    const body = response.json<{ applicationCount: number; applications: { referenceNumber: string }[] }>();
    expect(body.applicationCount).toBe(1);
    expect(body.applications.map((a) => a.referenceNumber)).toEqual(['BP-2026-000101']);
  });

  it('reports a business with no applications as none rather than omitting the field', async () => {
    const response = await app.inject({
      method: 'GET', url: `/staff/businesses/${joseBusiness}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });

    const body = response.json<{ applicationCount: number; applications: unknown[] }>();
    expect(body.applicationCount).toBe(0);
    expect(body.applications).toEqual([]);
  });
});

describe('filters', () => {
  const list = async (query: string): Promise<string[]> => {
    const response = await app.inject({
      method: 'GET', url: `/staff/businesses${query}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ data: { name: string }[] }>().data.map((b) => b.name);
  };

  it('filters by category and by status', async () => {
    expect(await list('?category=Retail')).toEqual(['Santos Sari-Sari Store']);
    expect(await list('?status=Inactive')).toEqual(['Rizal Hardware']);
    expect(await list('?category=Retail&status=Inactive')).toEqual([]);
  });

  it('searches name and registration number', async () => {
    expect(await list('?q=Hardware')).toEqual(['Rizal Hardware']);
    expect(await list('?q=BN-2024-0001')).toEqual(['Santos Sari-Sari Store']);
  });

  it('treats a wildcard as a character, not as a pattern', async () => {
    // The wildcards are added to the VALUE, so this searches for a percent sign
    // and finds nothing — rather than matching everything.
    expect(await list('?q=%25')).toEqual([]);
  });

  it('refuses a filter value outside the vocabulary instead of ignoring it', async () => {
    const response = await app.inject({
      method: 'GET', url: '/staff/businesses?status=Deleted',
      headers: { authorization: `Bearer ${officerToken}` },
    });

    // Silently ignoring an unknown filter answers a different question than the
    // one asked, and the caller cannot tell.
    expect(response.statusCode).toBe(400);
  });

  it('answers a missing business with 404, and a malformed id the same way', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const response = await app.inject({
        method: 'GET', url: `/staff/businesses/${id}`,
        headers: { authorization: `Bearer ${officerToken}` },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
