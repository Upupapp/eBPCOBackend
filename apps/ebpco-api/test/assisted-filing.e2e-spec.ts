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
 * TAB 03 — filing for a walk-in, at the counter.
 *
 * The property this exists to protect: WHO FILED IT and WHOSE PERMIT IT IS are
 * different facts, and the audit trail has to carry both. Everything else here
 * follows from `applicants.account_id` being NOT NULL and UNIQUE.
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
let officerId: string;
let officerToken: string;
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

const WALK_IN = {
  applicant: {
    firstName: 'Maria', lastName: 'Santos',
    email: 'maria.walkin@example.ph', mobileNumber: '+639171234567',
  },
  permitType: 'Fencing Permit',
  applicationAction: 'New' as const,
  location: '12 Rizal Street, Poblacion',
};

const file = (payload: Record<string, unknown>, token = officerToken, key = randomUUID()) =>
  app.inject({
    method: 'POST', url: '/staff/applications',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload,
  });

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  ({ id: officerId, token: officerToken } = await staffAccount('records-officer'));
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

describe('filing for someone at the counter', () => {
  it('creates the applicant, the account and the application in one request', async () => {
    const response = await file({ ...WALK_IN });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ applicationId: string; referenceNumber: string; applicantId: string }>();
    // The SAME generator the self-service path uses, which is why the filing
    // row was extracted rather than copied: two writers to one sequence would
    // eventually hand two applicants the same reference number.
    expect(body.referenceNumber).toMatch(/^E-BPCO-\d{4}-\d{6}$/);

    const application = await db.query<{ lifecycle_status: string; applicant_id: string }>(
      'select lifecycle_status, applicant_id from applications where id = $1', [body.applicationId],
    );
    expect(application.rows[0]?.lifecycle_status).toBe('Submitted');
    expect(application.rows[0]?.applicant_id).toBe(body.applicantId);
  });

  it('RECORDS THE OFFICER AS THE FILER AND THE WALK-IN AS THE APPLICANT', async () => {
    // The whole point. Collapsing the two would credit the applicant with an
    // act they did not perform and lose the record that the LGU filed for them.
    const response = await file({
      ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'filer.test@example.ph' },
    });
    const body = response.json<{ applicationId: string; applicantId: string }>();

    const row = await db.query<{ created_by: string; applicant_id: string }>(
      'select created_by, applicant_id from applications where id = $1', [body.applicationId],
    );
    expect(row.rows[0]?.created_by).toBe(officerId);
    expect(row.rows[0]?.applicant_id).toBe(body.applicantId);

    // And the applicant's own account is NOT the officer's.
    const owner = await db.query<{ account_id: string }>(
      'select account_id from applicants where id = $1', [body.applicantId],
    );
    expect(owner.rows[0]?.account_id).not.toBe(officerId);
  });

  it('writes an audit entry that says it was filed on behalf', async () => {
    await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'audited@example.ph' } });

    const audit = await db.query<{ actor_account_id: string; after_state: { accountCreated: boolean } }>(
      `select actor_account_id, after_state from audit_events
        where action = 'application.filed-on-behalf' order by sequence desc limit 1`,
    );
    expect(audit.rows[0]?.actor_account_id).toBe(officerId);
    expect(audit.rows[0]?.after_state.accountCreated).toBe(true);
  });

  it('gives the new account a password nobody can use, so the officer cannot act as them', async () => {
    await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'unclaimed@example.ph' } });

    const stored = await db.query<{ password_hash: string; kind: string }>(
      "select password_hash, kind from accounts where email_normalised = 'unclaimed@example.ph'",
    );
    expect(stored.rows[0]?.kind).toBe('applicant');
    expect(stored.rows[0]?.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{32}$/);

    const attempt = await app.inject({
      method: 'POST', url: '/auth/token',
      payload: { email: 'unclaimed@example.ph', password: 'anything-at-all' },
    });
    expect(attempt.statusCode).not.toBe(200);
  });

  it('registers a business in the same transaction and files against it', async () => {
    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'with.business@example.ph' },
      business: {
        name: 'Santos Sari-Sari Store', category: 'Retail', street: '12 Rizal Street',
        barangay: 'Poblacion', city: 'Castilla', province: 'Sorsogon',
        registrationNumber: 'BN-2026-0007', dateRegistered: '2026-01-15',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ applicationId: string; applicantId: string }>();
    const linked = await db.query<{ name: string; owner_applicant_id: string }>(
      `select b.name, b.owner_applicant_id from applications a
         join businesses b on b.id = a.business_id where a.id = $1`,
      [body.applicationId],
    );
    expect(linked.rows[0]?.name).toBe('Santos Sari-Sari Store');
    expect(linked.rows[0]?.owner_applicant_id).toBe(body.applicantId);
  });
});

describe('a returning walk-in', () => {
  it('reuses the existing applicant rather than splitting their history', async () => {
    const first = await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'returning@example.ph' } });
    const second = await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'RETURNING@example.ph' } });

    expect(second.statusCode).toBe(201);
    // Normalised, so the same address in different case is the same person.
    expect(second.json<{ applicantId: string }>().applicantId)
      .toBe(first.json<{ applicantId: string }>().applicantId);

    const accounts = await db.query<{ n: string }>(
      "select count(*) as n from accounts where email_normalised = 'returning@example.ph'",
    );
    expect(Number(accounts.rows[0]?.n)).toBe(1);
  });

  it('files against a business they already own', async () => {
    const first = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'owner@example.ph' },
      business: {
        name: 'Owner Hardware', category: 'Wholesale', street: '5 Mabini',
        barangay: 'Poblacion', city: 'Castilla', province: 'Sorsogon',
        registrationNumber: 'BN-2026-0008', dateRegistered: '2026-02-01',
      },
    });
    const applicantId = first.json<{ applicantId: string }>().applicantId;
    const business = await db.query<{ id: string }>(
      'select id from businesses where owner_applicant_id = $1', [applicantId],
    );

    const second = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'owner@example.ph' },
      businessId: business.rows[0]?.id,
    });

    expect(second.statusCode).toBe(201);
  });

  it("refuses to file against another applicant's business", async () => {
    // The same rule the self-service path enforces: filing against someone
    // else's business puts their registered name and address on this permit.
    const stranger = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'stranger@example.ph' },
      business: {
        name: 'Stranger Foods', category: 'Food Service', street: '9 Burgos',
        barangay: 'Poblacion', city: 'Castilla', province: 'Sorsogon',
        registrationNumber: 'BN-2026-0009', dateRegistered: '2026-02-02',
      },
    });
    const theirs = await db.query<{ id: string }>(
      'select id from businesses where owner_applicant_id = $1',
      [stranger.json<{ applicantId: string }>().applicantId],
    );

    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'someone.else@example.ph' },
      businessId: theirs.rows[0]?.id,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/not registered to this applicant/i);
  });
});

describe('what it refuses', () => {
  it('refuses an address belonging to an LGU staff account', async () => {
    // Attaching an applicant record to a staff account creates an identity that
    // can hold a permit but cannot use the mobile app — a staff token carries
    // no applications:write — so the person is stranded between populations.
    const colleague = await staffAccount('cashier');
    const email = await db.query<{ email: string }>(
      'select email from accounts where id = $1', [colleague.id],
    );

    const response = await file({
      ...WALK_IN, applicant: { ...WALK_IN.applicant, email: email.rows[0]?.email },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/staff account/i);
  });

  it('refuses a filing with no email, because the schema requires one', async () => {
    const { email: _omitted, ...withoutEmail } = WALK_IN.applicant;
    const response = await file({ ...WALK_IN, applicant: withoutEmail });

    expect(response.statusCode).toBe(400);
  });

  it('refuses both a new business and an existing one in the same request', async () => {
    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'both@example.ph' },
      businessId: randomUUID(),
      business: {
        name: 'Ambiguous', category: 'Other', street: '1 Main', barangay: 'Poblacion',
        city: 'Castilla', province: 'Sorsogon', registrationNumber: 'BN-1', dateRegistered: '2026-01-01',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a permit type the LGU does not issue', async () => {
    const response = await file({
      ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'bad.permit@example.ph' },
      permitType: 'Interdimensional Portal',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses an officer without applications:write', async () => {
    const evaluator = await staffAccount('evaluator');
    const response = await file(
      { ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'nope@example.ph' } },
      evaluator.token,
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('idempotency', () => {
  it('files once when the counter clerk retries the same request', async () => {
    const key = randomUUID();
    const payload = { ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'retry@example.ph' } };

    const first = await file(payload, officerToken, key);
    const second = await file(payload, officerToken, key);

    expect(first.statusCode).toBe(201);
    expect(second.json<{ referenceNumber: string }>().referenceNumber)
      .toBe(first.json<{ referenceNumber: string }>().referenceNumber);

    const applications = await db.query<{ n: string }>(
      `select count(*) as n from applications a join applicants ap on ap.id = a.applicant_id
         join accounts acc on acc.id = ap.account_id where acc.email_normalised = 'retry@example.ph'`,
    );
    expect(Number(applications.rows[0]?.n)).toBe(1);
  });

  it('refuses the same key carrying a different walk-in', async () => {
    const key = randomUUID();
    await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'first.person@example.ph' } },
      officerToken, key);
    const second = await file(
      { ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'second.person@example.ph' } },
      officerToken, key,
    );

    expect(second.statusCode).toBe(409);
  });

  it('requires a key at all', async () => {
    const response = await app.inject({
      method: 'POST', url: '/staff/applications',
      headers: { authorization: `Bearer ${officerToken}` },
      payload: { ...WALK_IN, applicant: { ...WALK_IN.applicant, email: 'nokey@example.ph' } },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('what a renewal renews', () => {
  /** An issued permit belonging to the walk-in this suite files for. */
  const permitFor = async (email: string, permitNumber: string): Promise<string> => {
    const filed = await file({ ...WALK_IN, applicant: { ...WALK_IN.applicant, email } });
    expect(filed.statusCode).toBe(201);
    const applicationId = filed.json<{ applicationId: string }>().applicationId;
    await db.query(
      `insert into generated_permits (application_id, permit_number, issued_date, generated_by)
       values ($1,$2, now(), $3)`,
      [applicationId, permitNumber, officerId],
    );
    return applicationId;
  };

  it('REFUSES a Renewal that names no permit', async () => {
    // The defect the column exists to prevent: an officer opening a renewal and
    // having to find the original by searching the applicant's name.
    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'renewal.nameless@example.ph' },
      applicationAction: 'Renewal',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/which permit/i);
  });

  it('links a Renewal to the permit it names', async () => {
    await permitFor('renewal.owner@example.ph', 'FP-2026-000501');

    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'renewal.owner@example.ph' },
      applicationAction: 'Renewal',
      renewsPermitNumber: 'FP-2026-000501',
    });

    expect(response.statusCode).toBe(201);
    const linked = await db.query<{ permit_number: string }>(
      `select g.permit_number from applications a
         join generated_permits g on g.application_id = a.renews_permit_id
        where a.id = $1`,
      [response.json<{ applicationId: string }>().applicationId],
    );
    expect(linked.rows[0]?.permit_number).toBe('FP-2026-000501');
  });

  it("REFUSES a permit that is not this applicant's", async () => {
    // Renewing someone else's permit would put their particulars on this
    // filing. The same rule the business check enforces one field away.
    await permitFor('renewal.stranger@example.ph', 'FP-2026-000502');

    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'renewal.thief@example.ph' },
      applicationAction: 'Renewal',
      renewsPermitNumber: 'FP-2026-000502',
    });

    expect(response.statusCode).toBe(422);
    // One answer for "no such permit" and "not yours": telling them apart
    // would let anyone test whether a permit number exists.
    expect(response.json<{ detail: string }>().detail).toMatch(/registered to this applicant/i);
  });

  it('answers an unknown permit number the same way as one that is not theirs', async () => {
    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'renewal.unknown@example.ph' },
      applicationAction: 'Renewal',
      renewsPermitNumber: 'FP-9999-999999',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/registered to this applicant/i);
  });

  it('refuses a New application that claims to renew something', async () => {
    await permitFor('renewal.confused@example.ph', 'FP-2026-000503');

    const response = await file({
      ...WALK_IN,
      applicant: { ...WALK_IN.applicant, email: 'renewal.confused@example.ph' },
      applicationAction: 'New',
      renewsPermitNumber: 'FP-2026-000503',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/does not renew/i);
  });

  it('is refused by the database too, not only by the service', async () => {
    // A row that says Renewal and names nothing is wrong however it was
    // written, so the constraint holds independently of the code path.
    const applicant = await db.query<{ id: string }>('select id from applicants limit 1');

    await expect(db.query(
      `insert into applications (reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ('E-BPCO-2026-999999', $1, 'Fencing Permit', 'Renewal', 'Submitted', now(), $2)`,
      [applicant.rows[0]?.id, officerId],
    )).rejects.toThrow(/renewal_names_what_it_renews/);
  });
});
