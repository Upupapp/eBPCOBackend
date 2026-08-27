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
import { IdentityService } from '../src/modules/identity/application/identity.service';
import { Scope, StaffRole, scopesFor } from '../src/modules/identity/domain/account';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';
import { visibleStatusesFor } from '../src/modules/applications/application/staff-queue.service';

/**
 * The staff surface over real HTTP.
 *
 * Every request here goes through the global authentication guard, the real
 * route table and the real database. The unit tests prove the query is right;
 * these prove it is reachable only by the right caller — which is a different
 * claim, and the one an in-memory admin never had to make.
 */

const env: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let applicantId: string;
const APPLICANT_ACCOUNT = randomUUID();

async function tokenFor(kind: 'applicant' | 'staff', scopes: readonly Scope[], sub = randomUUID()): Promise<string> {
  // `sid` is not optional: an access token that cannot be traced back to a
  // sign-in cannot be revoked with it, and the verifier rejects one without.
  const issued = await tokens.issueAccessToken({ sub, sid: randomUUID(), kind, scopes: [...scopes] });
  return issued.token;
}

/**
 * A real staff account, then a token for it.
 *
 * Not a token over an invented subject: `application_transitions` has a
 * foreign key to `accounts`, so an officer who does not exist cannot be
 * recorded as having moved anything. The constraint is right — an audit row
 * naming nobody is worse than no audit row — and a fixture that skips it tests
 * a database this service does not run against.
 */
async function staffToken(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  // scopesFor(), not ROLE_SCOPES: production issues tokens through it, and it
  // grants profile:* to every account on top of the role's job scopes. A helper
  // reading the role table directly quietly tests a narrower token than any
  // real caller holds.
  return tokenFor('staff', scopesFor({ kind: 'staff', roles: [role] }), id);
}

const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
  ['Assessed', 'Payment Submitted'], ['Payment Submitted', 'Payment Under Verification'],
  ['Payment Under Verification', 'Payment Verified'], ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
];

async function file(reference: string, target: LifecycleStatus): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','Submitted',now(),$4)`,
    [id, reference, applicantId, APPLICANT_ACCOUNT],
  );
  let current: LifecycleStatus = 'Submitted';
  while (current !== target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no route from ${current} to ${target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  return id;
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  const config = loadConfig(env);
  app = await createApp(config, new StructuredLogger('error', () => {}), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await app.close();
});

interface QueueBody { items: { referenceNumber: string }[]; nextCursor: string | null }

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }) });

describe('the staff surface is closed by default', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await get('/staff/applications');

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses a caller holding no application scope', async () => {
    // A REAL account with a narrow scope set. Minting a token over an invented
    // subject used to reach the scope check; it now stops at the guard's
    // account lookup with a 401, which is correct and is not what this test is
    // about.
    const id = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','narrow@lgu.gov.ph','narrow@lgu.gov.ph','scrypt$1$1$1$a$b')`,
      [id],
    );

    const response = await get(
      '/staff/applications',
      await tokenFor('staff', ['staff:administer'] as const, id),
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a token whose account no longer exists, as 401 and not 500', async () => {
    // The defect this replaces. A verified signature was let straight through,
    // and the first write that referenced the account hit a foreign key —
    // producing a 500 on a write and a 200 on a read, which is an existence
    // oracle wearing a server error.
    const response = await get('/staff/applications', await tokenFor('staff', ['applications:read'] as const));

    expect(response.statusCode).toBe(401);
  });

  it('answers a vanished account exactly as it answers a forged token', async () => {
    // Answering differently would make this an oracle for whether an account id
    // exists — the defect being fixed, repeated in a new place.
    const vanished = await get('/staff/applications', await tokenFor('staff', ['applications:read'] as const));
    const forged = await get('/staff/applications', 'not-a-real-token');

    expect(vanished.statusCode).toBe(forged.statusCode);
    expect(vanished.json()).toEqual({ ...forged.json(), instance: vanished.json().instance,
      correlationId: vanished.json().correlationId });
  });

  it('stops a DISABLED account inside its token’s lifetime', async () => {
    // `disabled_at` was checked at sign-in and at refresh and nowhere else, so
    // an account disabled a moment after either kept full access for up to
    // fifteen minutes. That window covers a staff member just offboarded and an
    // account suspended for suspected fraud.
    const token = await staffToken('building-official');
    expect((await get('/staff/applications', token)).statusCode).toBe(200);

    await db.query('update accounts set disabled_at = now() where kind = $1', ['staff']);

    const after = await get('/staff/applications', token);
    expect(after.statusCode).toBe(401);
    expect(after.json().detail).toMatch(/disabled/i);
  });

  it('stops an ERASED account, because erasure disables it', async () => {
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant',
      scopes: ['profile:read', 'profile:write'],
    })).token;
    expect((await get('/me', token)).statusCode).toBe(200);

    await app.inject({ method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${token}` } });

    expect((await get('/me', token)).statusCode).toBe(401);
  });

  it('stops an access token the moment its session is signed out', async () => {
    // Revoking the refresh token stops NEW access tokens being minted and does
    // nothing to one already issued — so signing out of a lost handset did
    // nothing for up to fifteen minutes, which is the whole window in which
    // signing out was the thing to do.
    const sid = randomUUID();
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid, kind: 'applicant', scopes: ['profile:read'],
    })).token;
    expect((await get('/me', token)).statusCode).toBe(200);

    await app.get(IdentityService).signOut(sid);

    const after = await get('/me', token);
    expect(after.statusCode).toBe(401);
    expect(after.json().detail).toMatch(/signed out/i);
  });

  it('signs every session out, not just the live ones', async () => {
    // Revoking only families with a live refresh token would leave an access
    // token from an already-expired family still working — exactly the case
    // someone signing out everywhere is worried about.
    const sid = randomUUID();
    await db.query(
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at, revoked_at)
       values ($1,$2,$3,'digest',now(),now() + interval '30 days', now())`,
      [randomUUID(), sid, APPLICANT_ACCOUNT],
    );
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid, kind: 'applicant', scopes: ['profile:read'],
    })).token;

    await app.get(IdentityService).signOutEverywhere(APPLICANT_ACCOUNT);

    expect((await get('/me', token)).statusCode).toBe(401);
  });

  it('leaves a session nobody signed out alone', async () => {
    // The revocation table records sessions that HAVE been signed out; it is
    // not a register of every session that exists. Treating an unrecorded
    // family as revoked would infer liveness from the absence of a row.
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;

    expect((await get('/me', token)).statusCode).toBe(200);
  });

  it('never asks the database on a public route', async () => {
    // The probes an orchestrator polls must not pay for this. They are
    // `@Public()`, so they skip the guard entirely — asserted by closing the
    // database and finding liveness still answers.
    await db.close();

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('refuses an applicant at the guard, even holding the read scope', async () => {
    // An applicant's token legitimately carries `applications:read` — it is how
    // they read their own — so scope never separated the two populations. It
    // used to pass the guard and be stopped by the row filter alone; /staff is
    // now staff-only at the guard, because the row filter is a rule each
    // service has to remember and `/staff/businesses` was written without it.
    await file('BP-1', 'Submitted');

    const response = await get('/staff/applications', await tokenFor('applicant', ['applications:read'] as const, APPLICANT_ACCOUNT));

    expect(response.statusCode).toBe(403);
  });

  it('still filters the rows, so the second gate has not quietly become the only one', () => {
    // The original intent of the test above, preserved. Defence in depth means
    // BOTH gates hold, and a guard added today is exactly the thing that makes
    // someone delete the filter tomorrow as redundant. Asserted directly,
    // because the guard now stops the request before the filter is reached.
    expect(visibleStatusesFor({
      accountId: APPLICANT_ACCOUNT, kind: 'applicant', scopes: ['applications:read'],
    })).toEqual([]);
  });
});

describe('what /me tells a portal', () => {
  it('names the roles and the scopes the token actually carries', async () => {
    // A portal that guesses from a role name it invented is how a menu comes
    // to offer actions the server will refuse.
    const response = await get('/me', await staffToken('cashier'));

    expect(response.statusCode).toBe(200);
    const body = response.json<{ kind: string; roles: string[]; scopes: string[] }>();
    expect(body.kind).toBe('staff');
    expect(body.roles).toEqual(['cashier']);
    expect(body.scopes).toContain('staff:verify-payment');
    expect(body.scopes).not.toContain('staff:approve');
  });

  it('gives an applicant their own name and number, which the mobile client reads', async () => {
    // A real defect this caught: /me returned neither, the Flutter client fell
    // back to empty strings, and every applicant saw a blank name and an empty
    // contact number. Nothing failed loudly enough for anyone to notice.
    const token = await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant',
      scopes: ['profile:read'],
    });

    const body = (await get('/me', token.token)).json<{
      kind: string; firstName: string; lastName: string; mobileNumber: string | null;
    }>();

    expect(body.kind).toBe('applicant');
    expect(body.firstName).toBe('Maria');
    expect(body.lastName).toBe('Santos');
  });

  it('does not give an applicant a roles or scopes field to read', async () => {
    // An applicant has no role: their authority comes entirely from owning the
    // record they are acting on. A null `roles` would invite a client to branch
    // on it.
    const token = await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    });

    const body = (await get('/me', token.token)).json<Record<string, unknown>>();

    expect(body).not.toHaveProperty('roles');
    expect(body).not.toHaveProperty('scopes');
  });

  it('erases an applicant over HTTP, and says what survives', async () => {
    // 202 with a body rather than 204. A 204 would be the LGU quietly keeping a
    // permit record while implying it kept nothing.
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:write'],
    })).token;

    const response = await app.inject({
      method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<{
      acceptedAt: string;
      erasedCategories: string[];
      retainedCategories: { category: string; basis: string; until: string | null }[];
    }>();
    expect(body.erasedCategories.length).toBeGreaterThan(0);
    expect(body.retainedCategories.map((r) => r.basis).join(' ')).toContain('PD 1096');
  });

  it('never names an internal table in the erasure receipt', async () => {
    // The row counts are evidence for the LGU, not for the applicant, and table
    // names are internal structure.
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:write'],
    })).token;

    const response = await app.inject({
      method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${token}` },
    });

    expect(JSON.stringify(response.json())).not.toMatch(/refresh_tokens|notification_deliveries|counts/);
  });

  it('refuses to erase a staff account, and says what to do instead', async () => {
    const response = await app.inject({
      method: 'DELETE', url: '/me',
      headers: { authorization: `Bearer ${await staffToken('evaluator')}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/offboarding/i);
  });

  it('queues a data export and answers with a request id', async () => {
    // RA 10173 §18. 202 and a request id, not the file: an export reads every
    // application, document record, payment and notification an applicant has,
    // and doing that inside a request times out for exactly the people with the
    // most data.
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;

    const response = await app.inject({
      method: 'POST', url: '/me/export', headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<{ requestId: string; requestedAt: string }>();
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns the same request when the button is pressed twice', async () => {
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;
    const post = () => app.inject({
      method: 'POST', url: '/me/export', headers: { authorization: `Bearer ${token}` },
    });

    const first = (await post()).json<{ requestId: string }>();
    const second = (await post()).json<{ requestId: string }>();

    expect(second.requestId).toBe(first.requestId);
  });

  it('lets an officer export their own data, because they are a data subject too', async () => {
    // RA 10173 rights belong to the person. Scoping the /me routes locked staff
    // out of their own export until `profile:*` was granted to every account
    // rather than to job roles — which is where it belongs, since reading your
    // own record is not a job function.
    const response = await app.inject({
      method: 'POST', url: '/me/export',
      headers: { authorization: `Bearer ${await staffToken('cashier')}` },
    });

    expect(response.statusCode).toBe(202);
  });

  it('will not show one applicant another’s export request', async () => {
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;
    const requestId = (await app.inject({
      method: 'POST', url: '/me/export', headers: { authorization: `Bearer ${token}` },
    })).json<{ requestId: string }>().requestId;

    // Another APPLICANT, which is the meaningful comparison — a staff caller
    // would now be refused by scope before reaching the ownership check, and
    // would prove the wrong thing.
    const someoneElse = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','other@example.ph','other@example.ph','scrypt$1$1$1$a$b')`,
      [someoneElse],
    );
    const theirToken = (await tokens.issueAccessToken({
      sub: someoneElse, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;

    const other = await app.inject({
      method: 'GET', url: `/me/export/${requestId}`,
      headers: { authorization: `Bearer ${theirToken}` },
    });

    expect(other.statusCode).toBe(404);
  });

  it('does not offer a download before the file exists', async () => {
    const token = (await tokens.issueAccessToken({
      sub: APPLICANT_ACCOUNT, sid: randomUUID(), kind: 'applicant', scopes: ['profile:read'],
    })).token;
    const requestId = (await app.inject({
      method: 'POST', url: '/me/export', headers: { authorization: `Bearer ${token}` },
    })).json<{ requestId: string }>().requestId;

    const download = await app.inject({
      method: 'GET', url: `/me/export/${requestId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(download.statusCode).toBe(404);
    expect(download.json().detail).toMatch(/still being produced|expired/i);
  });

  it('never returns anything that could authenticate the account', async () => {
    const response = await get('/me', await staffToken('evaluator'));

    expect(JSON.stringify(response.json())).not.toMatch(/scrypt|passwordHash|totp/i);
  });
});

describe('the queue', () => {
  it('returns the applications an officer may see', async () => {
    await file('BP-1', 'Submitted');
    await file('BP-2', 'Ready for Release');

    const response = await get('/staff/applications', await staffToken('building-official'));

    expect(response.statusCode).toBe(200);
    expect(response.json<QueueBody>().items.map((r) => r.referenceNumber).sort())
      .toEqual(['BP-1', 'BP-2']);
  });

  it('narrows to the requested status', async () => {
    await file('BP-1', 'Submitted');
    await file('BP-2', 'Ready for Release');

    const response = await get('/staff/applications?status=Submitted', await staffToken('building-official'));

    expect(response.json().items).toHaveLength(1);
  });

  it('rejects a status that is not one', async () => {
    const response = await get('/staff/applications?status=Nearly%20Done', await staffToken('building-official'));

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].pointer).toBe('/status');
  });

  it('serves the dashboard from its own path, not as an application id', async () => {
    // Route order. Registered after `:applicationId`, this request becomes a
    // lookup for an application called "metrics" and 404s.
    await file('BP-1', 'Submitted');

    const response = await get('/staff/applications/metrics', await staffToken('building-official'));

    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(1);
  });
});

describe('opening one application', () => {
  it('returns it whole, in one request', async () => {
    const id = await file('BP-1', 'Under Evaluation');

    const response = await get(`/staff/applications/${id}`, await staffToken('evaluator'));

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary.referenceNumber).toBe('BP-1');
    expect(body.applicantEmail).toBe('a@x.ph');
    expect(body).toHaveProperty('documents');
    expect(body).toHaveProperty('timeline');
  });

  it('spells its fields the way the rest of the API does', async () => {
    // Postgres answers in snake_case and every other response here is
    // camelCase. Letting raw rows through made this the one endpoint a client
    // had to spell differently — and the admin's mapper had already grown
    // `row['uploaded_at'] ?? row['uploadedAt']` hedges, written by someone who
    // could not tell which they would get.
    const id = await file('BP-1', 'Under Evaluation');
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared)
       values ($1,$2,$3,'Identity','id.pdf','application/pdf',1024,
               '${'a'.repeat(64)}','documents/id.pdf','Approved',true)`,
      [randomUUID(), id, APPLICANT_ACCOUNT],
    );

    const body = (await get(`/staff/applications/${id}`, await staffToken('evaluator')))
      .json<{ documents: Record<string, unknown>[] }>();

    expect(Object.keys(body.documents[0]!)).toContain('fileName');
    expect(JSON.stringify(body)).not.toMatch(/"[a-z]+_[a-z]/);
  });

  it('never sends a business column the client has no use for', async () => {
    // `select b.*` sends whatever the next migration adds — owner ids, audit
    // columns, a field added for something else entirely — and nobody reviews
    // a disclosure that happened by default.
    const businessId = randomUUID();
    await db.query(
      `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                               province, registration_number, date_registered, status)
       values ($1,$2,'Aling Nena','Retail','1 Main','Poblacion','Cabuyao','Laguna','DTI-1','2024-01-15','Active')`,
      [businessId, applicantId],
    );
    const id = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                                 application_action, lifecycle_status, submitted_at, created_by)
       values ($1,'BP-9',$2,$3,'Fencing','New','Submitted',now(),$4)`,
      [id, applicantId, businessId, APPLICANT_ACCOUNT],
    );

    const body = (await get(`/staff/applications/${id}`, await staffToken('records-officer')))
      .json<{ business: Record<string, unknown> }>();

    expect(Object.keys(body.business).sort()).toEqual([
      'barangay', 'category', 'city', 'dateRegistered', 'id', 'name',
      'province', 'registrationNumber', 'status', 'street',
    ]);
  });

  it('answers 404, not 403, for one the officer may not read', async () => {
    // Telling a cashier that this reference exists but is not theirs to open
    // confirms a neighbour has applied for a permit.
    const id = await file('BP-1', 'Submitted');

    const response = await get(`/staff/applications/${id}`, await staffToken('cashier'));

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an id that is not a UUID, without touching the database', async () => {
    const response = await get('/staff/applications/1%20or%201=1', await staffToken('building-official'));

    expect(response.statusCode).toBe(404);
  });
});

describe('moving an application', () => {
  const post = (url: string, token: string, payload: Record<string, unknown>, key = randomUUID()) =>
    app.inject({
      method: 'POST', url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload,
    });

  it('records a legal move and returns the new version', async () => {
    const id = await file('BP-1', 'Submitted');

    const response = await post(`/staff/applications/${id}/transitions`, await staffToken('records-officer'), {
      to: 'Received',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('Received');
    expect(response.json().version).toBeGreaterThan(1);
  });

  it('refuses an illegal move with 409 and says what IS legal', async () => {
    // An officer told only "no" tries again. Told what the application can do
    // next, they do that instead.
    const id = await file('BP-1', 'Submitted');

    const response = await post(`/staff/applications/${id}/transitions`, await staffToken('records-officer'), {
      to: 'Approved',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain('Received');
  });

  it('refuses a stale write with 412 rather than overwriting', async () => {
    // Two officers with the same application open. The second must be told
    // their view is out of date, not silently win.
    const id = await file('BP-1', 'Submitted');
    const token = await staffToken('records-officer');
    await post(`/staff/applications/${id}/transitions`, token, { to: 'Received' });

    const late = await post(`/staff/applications/${id}/transitions`, token, {
      to: 'Received', expectedVersion: 1,
    });

    expect(late.statusCode).toBe(412);
    expect(late.json().detail).toContain('Reload');
  });

  it('refuses an unmet precondition with 422 and names what is missing', async () => {
    // Not 403. "You have not paid yet" and "you may not do this" send an
    // officer to two different places.
    const id = await file('BP-1', 'Payment Under Verification');

    const response = await post(`/staff/applications/${id}/transitions`, await staffToken('cashier'), {
      to: 'Payment Verified',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/payment/i);
  });

  it('refuses a move with no Idempotency-Key rather than doing it anyway', async () => {
    const id = await file('BP-1', 'Submitted');

    const response = await app.inject({
      method: 'POST', url: `/staff/applications/${id}/transitions`,
      headers: { authorization: `Bearer ${await staffToken('records-officer')}` },
      payload: { to: 'Received' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('replays a lost response instead of blaming a colleague', async () => {
    // The failure this exists for: an officer clicks Receive, the server
    // commits, the response is lost. Without a key the retry carries the
    // version still on screen, the server finds it stale, and answers "someone
    // else changed this application while it was open" — untrue, unhelpful, and
    // in a permit office a question about who did what.
    const id = await file('BP-1', 'Submitted');
    const token = await staffToken('records-officer');
    const key = randomUUID();

    const first = await post(`/staff/applications/${id}/transitions`, token, { to: 'Received', expectedVersion: 1 }, key);
    const retry = await post(`/staff/applications/${id}/transitions`, token, { to: 'Received', expectedVersion: 1 }, key);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });

  it('moves the application exactly once, however many times the key is replayed', async () => {
    const id = await file('BP-1', 'Submitted');
    const token = await staffToken('records-officer');
    const key = randomUUID();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await post(`/staff/applications/${id}/transitions`, token, { to: 'Received' }, key);
    }

    const transitions = await db.query<{ n: string }>(
      `select count(*) as n from application_transitions
        where application_id = $1 and to_status = 'Received'`, [id],
    );
    expect(Number(transitions.rows[0]!.n)).toBe(1);
  });

  it('refuses the same key used for a DIFFERENT request', async () => {
    // Honouring it would answer for the wrong request — the caller would be
    // told a move succeeded that was never attempted.
    const id = await file('BP-1', 'Submitted');
    const token = await staffToken('records-officer');
    const key = randomUUID();

    await post(`/staff/applications/${id}/transitions`, token, { to: 'Received' }, key);
    const different = await post(`/staff/applications/${id}/transitions`, token, { to: 'Cancelled' }, key);

    expect(different.statusCode).toBe(409);
    expect(different.json().detail).toMatch(/already used for a different request/i);
  });

  it('does not record a key for a move that was refused', async () => {
    // A key recorded outside the transaction would replay a result nothing
    // produced: the officer retries a corrected request with the same key and
    // is told the original failure succeeded.
    const id = await file('BP-1', 'Submitted');
    const token = await staffToken('records-officer');
    const key = randomUUID();

    const refused = await post(`/staff/applications/${id}/transitions`, token, { to: 'Approved' }, key);
    expect(refused.statusCode).toBe(409);

    const keys = await db.query<{ n: string }>('select count(*) as n from idempotency_keys');
    expect(Number(keys.rows[0]!.n)).toBe(0);
  });

  it('refuses to move one the officer may not even read', async () => {
    const id = await file('BP-1', 'Submitted');

    const response = await post(`/staff/applications/${id}/transitions`, await staffToken('releasing-officer'), {
      to: 'Received',
    });

    expect(response.statusCode).toBe(404);
  });
});
