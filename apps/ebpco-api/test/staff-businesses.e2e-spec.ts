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
  TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
  PUSH_TOKEN_ENCRYPTION_KEY: 'a-test-push-key-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let officerToken: string;
let recordsOfficerToken: string;
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
  // `applications:write`, which `GET /staff/businesses` never needed but
  // `POST /staff/businesses` does -- the same scope `fileOnBehalf` requires,
  // since this is the same kind of counter transaction.
  recordsOfficerToken = await staffToken('records-officer');

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
     values ($1,'BP-2026-000101',$2,$3,'Fencing Permit','New','Submitted', now(), $4)`,
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

describe('registering a business at the counter', () => {
  const register = (payload: Record<string, unknown>, token = recordsOfficerToken, key = randomUUID()) =>
    app.inject({
      method: 'POST', url: '/staff/businesses',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload,
    });

  const WALK_IN = {
    owner: {
      firstName: 'Pedro', lastName: 'Cruz',
      email: 'pedro.walkin@example.ph', mobileNumber: '+639187654321',
    },
    business: {
      name: 'Cruz Bakeshop', category: 'Food Service', street: '5 Rizal Street',
      barangay: 'Poblacion', city: 'Castilla', province: 'Sorsogon',
      registrationNumber: 'BN-2026-9001', dateRegistered: '2026-01-15',
    },
  };

  it('creates the owner\'s account, applicant record and the business in one request', async () => {
    const response = await register(WALK_IN);

    expect(response.statusCode).toBe(201);
    const body = response.json<{ businessId: string; applicantId: string; ownerNextStep: string | null }>();
    expect(body.ownerNextStep).toMatch(/account recovery/);

    const row = await db.query<{ owner_applicant_id: string; name: string }>(
      'select owner_applicant_id, name from businesses where id = $1', [body.businessId],
    );
    expect(row.rows[0]?.name).toBe('Cruz Bakeshop');
    expect(row.rows[0]?.owner_applicant_id).toBe(body.applicantId);

    const account = await db.query<{ password_hash: string; kind: string }>(
      `select acc.password_hash, acc.kind from accounts acc
         join applicants ap on ap.account_id = acc.id where ap.id = $1`,
      [body.applicantId],
    );
    expect(account.rows[0]?.kind).toBe('applicant');
    // Never a password an officer chose -- see NewBusiness's own doc comment.
    expect(account.rows[0]?.password_hash).not.toBe('');
  });

  it('never asks for -- or accepts -- a password for the owner', async () => {
    const response = await register({
      ...WALK_IN,
      owner: { ...WALK_IN.owner, email: 'no.password.field@example.ph', password: 'hunter2' },
    });
    // `.strict()` refuses the unknown `password` field outright, rather than
    // silently dropping it -- a client sending it has been given no reason to
    // think it was ignored.
    expect(response.statusCode).toBe(400);
  });

  it('reuses the SAME applicant record for a returning owner rather than splitting their businesses', async () => {
    const first = await register(WALK_IN, recordsOfficerToken, randomUUID());
    const firstBody = first.json<{ applicantId: string }>();

    const second = await register({
      owner: WALK_IN.owner,
      business: { ...WALK_IN.business, name: 'Cruz Sari-Sari Store', registrationNumber: 'BN-2026-9002' },
    }, recordsOfficerToken, randomUUID());
    const secondBody = second.json<{ applicantId: string }>();

    expect(second.statusCode).toBe(201);
    expect(secondBody.applicantId).toBe(firstBody.applicantId);
  });

  it('replays the same result for a repeated Idempotency-Key rather than double-registering', async () => {
    const key = randomUUID();
    const owner = { ...WALK_IN.owner, email: 'idempotent.owner@example.ph' };
    const business = { ...WALK_IN.business, registrationNumber: 'BN-2026-9099' };

    const first = await register({ owner, business }, recordsOfficerToken, key);
    const second = await register({ owner, business }, recordsOfficerToken, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const count = await db.query<{ n: string }>(
      'select count(*)::text as n from businesses where registration_number = $1',
      [business.registrationNumber],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('refuses a reused key carrying a different request', async () => {
    const key = randomUUID();
    const owner = { ...WALK_IN.owner, email: 'mismatch.owner@example.ph' };
    await register({ owner, business: WALK_IN.business }, recordsOfficerToken, key);

    const response = await register(
      { owner, business: { ...WALK_IN.business, name: 'A Different Business' } },
      recordsOfficerToken, key,
    );
    expect(response.statusCode).toBe(409);
  });

  it('refuses an owner email that belongs to an LGU staff account', async () => {
    const staffId = randomUUID();
    const staffEmail = `existing-staff-${staffId.slice(0, 8)}@lgu.gov.ph`;
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
      [staffId, staffEmail],
    );

    const response = await register({ owner: { ...WALK_IN.owner, email: staffEmail }, business: WALK_IN.business });
    expect(response.statusCode).toBe(422);
  });

  it('refuses without applications:write', async () => {
    const evaluatorToken = await staffToken('evaluator');
    const response = await register(WALK_IN, evaluatorToken);
    expect(response.statusCode).toBe(403);
  });

  it('requires an Idempotency-Key', async () => {
    const response = await app.inject({
      method: 'POST', url: '/staff/businesses',
      headers: { authorization: `Bearer ${recordsOfficerToken}` },
      payload: WALK_IN,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('staff editing and deactivating a business', () => {
  // Own fixtures per test, rather than the shared mariaBusiness/joseBusiness
  // from beforeAll — those rows' current names/statuses are asserted against
  // by other tests in this file, and this describe mutates the rows it acts on.
  async function freshBusiness(status: 'Active' | 'Inactive' = 'Active') {
    const suffix = randomUUID().slice(0, 8);
    return applicantWithBusiness({
      first: 'Ana', last: 'Reyes', email: `ana-${suffix}@example.ph`, mobile: null,
      business: `Reyes Bakery ${suffix}`, category: 'Retail', registration: `BN-${suffix}`, status,
    });
  }

  const edit = (businessId: string, body: Record<string, unknown>, token = recordsOfficerToken) =>
    app.inject({
      method: 'PATCH', url: `/staff/businesses/${businessId}`,
      headers: { authorization: `Bearer ${token}` }, payload: body,
    });

  const setStatus = (businessId: string, action: 'deactivate' | 'reactivate', token = recordsOfficerToken) =>
    app.inject({
      method: 'POST', url: `/staff/businesses/${businessId}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('corrects the owner-editable fields, on any business (not just the officer\'s own)', async () => {
    const { businessId } = await freshBusiness();

    const response = await edit(businessId, {
      name: 'Reyes Bakery and Cafe', category: 'Food Service',
      street: '9 Bonifacio Street', barangay: 'Mayon', city: 'Castilla', province: 'Sorsogon',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ name: string; category: string }>()).toMatchObject({
      name: 'Reyes Bakery and Cafe', category: 'Food Service',
    });
  });

  it('never lets the government-assigned facts be rewritten through this route', async () => {
    const { businessId } = await freshBusiness();

    const response = await edit(businessId, {
      name: 'X', category: 'Retail', street: 'x', barangay: 'x', city: 'x', province: 'x',
      registrationNumber: 'FORGED-0001',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses without applications:write', async () => {
    const { businessId } = await freshBusiness();

    const response = await edit(businessId, {
      name: 'X', category: 'Retail', street: 'x', barangay: 'x', city: 'x', province: 'x',
    }, officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for a business id that does not exist', async () => {
    const response = await edit(randomUUID(), {
      name: 'X', category: 'Retail', street: 'x', barangay: 'x', city: 'x', province: 'x',
    });

    expect(response.statusCode).toBe(404);
  });

  it('deactivates a business, marking it Inactive rather than deleting it', async () => {
    const { businessId } = await freshBusiness();

    const response = await setStatus(businessId, 'deactivate');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('Inactive');
    const row = await db.query<{ id: string }>('select id from businesses where id = $1', [businessId]);
    expect(row.rows.length).toBe(1);
  });

  it('is reversible', async () => {
    const { businessId } = await freshBusiness();
    await setStatus(businessId, 'deactivate');

    const response = await setStatus(businessId, 'reactivate');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('Active');
  });

  it('refuses to deactivate while an application against it is still in progress', async () => {
    const { businessId, applicantId, accountId } = await freshBusiness();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                                 application_action, lifecycle_status, submitted_at, created_by)
       values ($1,$2,$3,$4,'Fencing Permit','New','Submitted', now(), $5)`,
      [randomUUID(), `BP-${randomUUID().slice(0, 8)}`, applicantId, businessId, accountId],
    );

    const response = await setStatus(businessId, 'deactivate');

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/still in progress/i);
  });
});
