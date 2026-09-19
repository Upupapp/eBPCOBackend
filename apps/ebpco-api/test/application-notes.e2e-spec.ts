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
 * `application_notes` — the internal staff workspace on an application.
 *
 * The property this file exists to protect, and that nothing caught the one
 * time it broke: `POST .../notes` was first gated on `applications:read`,
 * which `auditor` also holds — so the read-only oversight role could write.
 * `test/staff-roles.e2e-spec.ts` catches that class of bug for every staff
 * route in one sweep, but only because a route exists for it to probe; this
 * file is the one place that probes what a real note, on a real application,
 * actually does.
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
let applicationId: string;
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

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  const accountId = randomUUID();
  const applicantId = randomUUID();
  const businessId = randomUUID();
  applicationId = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant',$2,$2,'scrypt$1$1$1$a$b')`,
    [accountId, 'notes.applicant@example.ph'],
  );
  await db.query(
    'insert into applicants (id, account_id, first_name, last_name) values ($1,$2,$3,$4)',
    [applicantId, accountId, 'Notes', 'Applicant'],
  );
  await db.query(
    `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                             province, registration_number, date_registered)
     values ($1,$2,'Notes Test Store','Retail','1 Rizal Street','Poblacion','Castilla',
             'Sorsogon','BN-NOTES-0001','2024-01-01')`,
    [businessId, applicantId],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                               application_action, lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000900',$2,$3,'Fencing Permit','New','Submitted', now(), $4)`,
    [applicationId, applicantId, businessId, accountId],
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

describe('reading and writing notes', () => {
  it('starts empty, then carries a posted note back with a real author and timestamp', async () => {
    const officer = await staffToken('evaluator');

    const empty = await app.inject({
      method: 'GET', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ notes: unknown[] }>().notes).toEqual([]);

    const posted = await app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` },
      payload: { body: 'Land title matches the applicant on file.' },
    });
    expect(posted.statusCode).toBe(201);
    const note = posted.json<{ note: { id: string; body: string; depth: number; authorEmail: string } }>().note;
    expect(note.body).toBe('Land title matches the applicant on file.');
    expect(note.depth).toBe(0);
    expect(note.authorEmail).toContain('evaluator-');

    const listed = await app.inject({
      method: 'GET', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` },
    });
    expect(listed.json<{ notes: { id: string }[] }>().notes.map((n) => n.id)).toEqual([note.id]);
  });

  it('caps reply depth at two levels regardless of how deep the thread already is', async () => {
    const officer = await staffToken('records-officer');
    const post = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` }, payload,
    });

    const root = (await post({ body: 'root' })).json<{ note: { id: string; depth: number } }>().note;
    expect(root.depth).toBe(0);
    const reply1 = (await post({ body: 'reply one', parentNoteId: root.id }))
      .json<{ note: { id: string; depth: number } }>().note;
    expect(reply1.depth).toBe(1);
    const reply2 = (await post({ body: 'reply two', parentNoteId: reply1.id }))
      .json<{ note: { id: string; depth: number } }>().note;
    expect(reply2.depth).toBe(2);
    // A reply to a depth-2 note stays at 2 rather than growing unbounded.
    const reply3 = (await post({ body: 'reply three', parentNoteId: reply2.id }))
      .json<{ note: { id: string; depth: number } }>().note;
    expect(reply3.depth).toBe(2);
  });

  it('refuses an empty note and a reply to a note from another application', async () => {
    const officer = await staffToken('evaluator');

    const empty = await app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` }, payload: { body: '   ' },
    });
    expect(empty.statusCode).toBe(422);

    const foreign = await app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${officer}` },
      payload: { body: 'orphan reply', parentNoteId: randomUUID() },
    });
    expect(foreign.statusCode).toBe(422);
  });

  it('answers a missing application with 404 on both routes', async () => {
    const officer = await staffToken('evaluator');
    const missing = randomUUID();

    expect((await app.inject({
      method: 'GET', url: `/staff/applications/${missing}/notes`,
      headers: { authorization: `Bearer ${officer}` },
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: 'POST', url: `/staff/applications/${missing}/notes`,
      headers: { authorization: `Bearer ${officer}` }, payload: { body: 'hello' },
    })).statusCode).toBe(404);
  });
});

describe('the auditor may read, never write', () => {
  it('lets the auditor list notes like any other role that can open the application', async () => {
    const auditor = await staffToken('auditor');
    const response = await app.inject({
      method: 'GET', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${auditor}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses the auditor a note outright — oversight without authority', async () => {
    const auditor = await staffToken('auditor');
    const response = await app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${auditor}` },
      payload: { body: 'an auditor should never be able to write this' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets every other acting role post one', async () => {
    // Not every acting role: `assessor`/`cashier`/`releasing-officer` cannot
    // see a 'Submitted' application at all (`visibility.ts`'s own per-scope
    // stage gate — Under Evaluation/Assessed onward respectively), so they
    // 404 before authorisation is reached, same as the ENGINE_AUTHORISED
    // routes in staff-roles.e2e-spec.ts. That is a queue-visibility question,
    // not what this test asks. These five span the rest of the scope
    // spectrum -- an 'all'-visibility scope, a stage-gated one, and
    // `applications:write` -- for the one question this test does ask.
    const roles: StaffRole[] = [
      'receiving-officer', 'records-officer', 'evaluator', 'building-official', 'super-admin',
    ];
    for (const role of roles) {
      const token = await staffToken(role);
      const response = await app.inject({
        method: 'POST', url: `/staff/applications/${applicationId}/notes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: `note from ${role}` },
      });
      expect(response.statusCode).toBe(201);
    }
  });

  it('refuses the one acting role with no path to an application at all', async () => {
    // `administrator` holds no `applications:read` either, so it was already
    // refused before this fix — asserted so a future scope change cannot
    // quietly open this route to a role that still cannot see the record.
    const admin = await staffToken('administrator');
    const response = await app.inject({
      method: 'POST', url: `/staff/applications/${applicationId}/notes`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { body: 'should never post' },
    });
    expect(response.statusCode).toBe(403);
  });
});
