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
import { EvaluationStage } from '../src/modules/applications/domain/evaluation-stages';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * Officer positions (migration 057), over HTTP: each evaluation stage is one
 * office's, a super admin can remove a staff account, and every application
 * says who it is waiting on.
 *
 * The owner's own example is the first test: a fire safety officer approves
 * the fire safety evaluation and cannot approve any other stage.
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

jest.setTimeout(30_000);

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let applicantId: string;
const APPLICANT_ACCOUNT = randomUUID();

interface Officer { readonly id: string; readonly token: string }

async function officer(
  roles: readonly StaffRole[], stages: readonly EvaluationStage[] = [], name = 'Officer',
): Promise<Officer> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, full_name)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b',$3)`,
    [id, `${roles.join('-')}-${id.slice(0, 8)}@lgu.gov.ph`, name],
  );
  for (const role of roles) {
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  }
  await db.query('insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)', [id, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [id]);
  for (const stage of stages) {
    await db.query('insert into staff_evaluation_stages (account_id, stage, granted_by) values ($1,$2,$1)', [id, stage]);
  }
  const issued = await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff', scopes: [...scopesFor({ kind: 'staff', roles: [...roles] })],
  });
  return { id, token: issued.token };
}

/** The legal path, one move at a time — the database refuses creating an application past Submitted. */
const PATH: readonly LifecycleStatus[] = [
  'Submitted', 'Received', 'Document Verification', 'Under Evaluation', 'Assessed',
];

async function file(status: LifecycleStatus, passed: readonly EvaluationStage[] = []): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing Permit','New','Submitted',now(),$4)`,
    [id, `BP-${id.slice(0, 6)}`, applicantId, APPLICANT_ACCOUNT],
  );
  for (const next of PATH.slice(1, PATH.indexOf(status) + 1)) {
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
  }
  const recorder = passed.length === 0 ? null : await officer(['evaluator'], [...passed]);
  for (const stage of passed) {
    await db.query(
      `insert into evaluations (application_id, stage, result, evaluator_id, evaluated_at)
       values ($1,$2,'Passed',$3,now())`,
      [id, stage, recorder!.id],
    );
  }
  return id;
}

const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
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

describe('an evaluator decides only the stages assigned to them', () => {
  it('lets the fire safety officer pass Fire Safety, and no other stage', async () => {
    const fire = await officer(['evaluator'], ['Fire Safety']);
    const atFireSafety = await file('Under Evaluation', ['Initial', 'Zoning']);
    const atInitial = await file('Under Evaluation');

    const other = await send('POST', `/staff/applications/${atInitial}/evaluations`, fire.token,
      { stage: 'Initial', result: 'Passed' });
    expect(other.statusCode).toBe(403);
    expect(other.json<{ detail: string }>().detail).toContain('The Initial stage is not assigned to your account');

    const own = await send('POST', `/staff/applications/${atFireSafety}/evaluations`, fire.token,
      { stage: 'Fire Safety', result: 'Passed' });
    expect(own.statusCode).toBe(201);
  });

  it('refuses an evaluator with no stage assigned — none means none, never all', async () => {
    const unassigned = await officer(['evaluator']);
    const id = await file('Under Evaluation');

    const response = await send('POST', `/staff/applications/${id}/evaluations`, unassigned.token,
      { stage: 'Initial', result: 'Passed' });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toContain('no evaluation stage assigned');
  });

  it('keeps the super admin able to decide every stage', async () => {
    const superAdmin = await officer(['super-admin']);
    const id = await file('Under Evaluation', ['Initial', 'Zoning', 'Fire Safety']);

    const response = await send('POST', `/staff/applications/${id}/evaluations`, superAdmin.token,
      { stage: 'OBO', result: 'Passed' });

    expect(response.statusCode).toBe(201);
  });

  it('lets only the officer of the stage an application is on send it back for revision', async () => {
    const zoning = await officer(['evaluator'], ['Zoning']);
    const fire = await officer(['evaluator'], ['Fire Safety']);
    const id = await file('Under Evaluation', ['Initial', 'Zoning']);
    const remarks = 'The fire exit on sheet A-2 is narrower than the 1.12 m the Fire Code requires.';

    const refused = await send('POST', `/staff/applications/${id}/transitions`, zoning.token,
      { to: 'Revision Required', remarks });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ detail: string }>().detail).toContain('at the Fire Safety evaluation stage');

    const allowed = await send('POST', `/staff/applications/${id}/transitions`, fire.token,
      { to: 'Revision Required', remarks });
    expect(allowed.statusCode).toBe(200);
  });

  it('gives the move out of Document Verification to the Initial evaluator', async () => {
    const fire = await officer(['evaluator'], ['Fire Safety']);
    const initial = await officer(['evaluator'], ['Initial']);
    const id = await file('Document Verification');
    const remarks = 'The barangay clearance attached has expired; attach one issued this year.';

    const refused = await send('POST', `/staff/applications/${id}/transitions`, fire.token,
      { to: 'Revision Required', remarks });
    expect(refused.statusCode).toBe(403);

    const allowed = await send('POST', `/staff/applications/${id}/transitions`, initial.token,
      { to: 'Revision Required', remarks });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('assigning stages', () => {
  it('sets, reports and audits an officer\'s stages, and /me carries them', async () => {
    const admin = await officer(['super-admin']);
    const evaluator = await officer(['evaluator']);

    const set = await send('PUT', `/staff/users/${evaluator.id}/access/stages`, admin.token,
      { stages: ['Zoning', 'Fire Safety'] });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ evaluationStages: string[] }>().evaluationStages).toEqual(['Zoning', 'Fire Safety']);

    const read = await send('GET', `/staff/users/${evaluator.id}/access`, admin.token);
    expect(read.json<{ evaluationStages: string[] }>().evaluationStages).toEqual(['Zoning', 'Fire Safety']);

    const me = await send('GET', '/me', evaluator.token);
    expect(me.json<{ evaluationStages: string[] }>().evaluationStages).toEqual(['Zoning', 'Fire Safety']);

    const audit = await db.query<{ action: string; after_state: { stages: string[] } }>(
      `select action, after_state from audit_events where subject_id = $1 and action = 'access.stages-changed'`,
      [evaluator.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after_state.stages).toEqual(['Zoning', 'Fire Safety']);
  });

  it('refuses a stage that does not exist', async () => {
    const admin = await officer(['super-admin']);
    const evaluator = await officer(['evaluator']);

    const response = await send('PUT', `/staff/users/${evaluator.id}/access/stages`, admin.token,
      { stages: ['Plumbing'] });

    expect(response.statusCode).toBe(409);
  });

  it('keeps an officer from assigning stages without staff:administer', async () => {
    const evaluator = await officer(['evaluator'], ['Initial']);

    const response = await send('PUT', `/staff/users/${evaluator.id}/access/stages`, evaluator.token,
      { stages: ['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'] });

    expect(response.statusCode).toBe(403);
  });
});

describe('a super admin deleting a staff account', () => {
  it('deletes an account that never acted, freeing its address', async () => {
    const admin = await officer(['super-admin']);
    const unused = await officer(['cashier']);

    const response = await send('DELETE', `/staff/users/${unused.id}`, admin.token);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ mode: string }>().mode).toBe('deleted');
    const gone = await db.query('select 1 from accounts where id = $1', [unused.id]);
    expect(gone.rows).toHaveLength(0);
  });

  it('retires an account whose name is on a decision, keeping the name on it', async () => {
    const admin = await officer(['super-admin']);
    const fire = await officer(['evaluator'], ['Fire Safety'], 'Juan Dela Cruz');
    const id = await file('Under Evaluation', ['Initial', 'Zoning']);
    const decided = await send('POST', `/staff/applications/${id}/evaluations`, fire.token,
      { stage: 'Fire Safety', result: 'Passed' });
    expect(decided.statusCode).toBe(201);

    const response = await send('DELETE', `/staff/users/${fire.id}`, admin.token);

    expect(response.json<{ mode: string }>().mode).toBe('retired');
    const row = await db.query<{ removed_at: Date | null; disabled_at: Date | null; full_name: string }>(
      'select removed_at, disabled_at, full_name from accounts where id = $1', [fire.id]);
    expect(row.rows[0]!.removed_at).not.toBeNull();
    expect(row.rows[0]!.disabled_at).not.toBeNull();
    expect(row.rows[0]!.full_name).toBe('Juan Dela Cruz');
    const evaluation = await db.query('select 1 from evaluations where evaluator_id = $1', [fire.id]);
    expect(evaluation.rows).toHaveLength(1);

    const list = await send('GET', '/staff/users', admin.token);
    expect(JSON.stringify(list.json())).not.toContain(fire.id);
  });

  it('lets only a super admin do it — not an administrator', async () => {
    const administrator = await officer(['administrator']);
    const target = await officer(['cashier']);

    const response = await send('DELETE', `/staff/users/${target.id}`, administrator.token);

    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toContain('Only a super admin');
  });

  it('refuses deleting your own account', async () => {
    const admin = await officer(['super-admin']);

    const response = await send('DELETE', `/staff/users/${admin.id}`, admin.token);

    expect(response.statusCode).toBe(403);
  });
});

describe('every application says who it is waiting on', () => {
  it('names the fire safety officer while an application is at Fire Safety, and only them', async () => {
    const admin = await officer(['super-admin']);
    await officer(['evaluator'], ['Zoning'], 'Zoning Officer Reyes');
    await officer(['evaluator'], ['Fire Safety'], 'Inspector Bautista');
    const id = await file('Under Evaluation', ['Initial', 'Zoning']);

    const detail = await send('GET', `/staff/applications/${id}`, admin.token);
    const responsibility = detail.json<{ summary: { responsibility: {
      step: string; holder: string; stage: string; officers: { name: string }[];
    } } }>().summary.responsibility;

    expect(responsibility.step).toBe('Decide the Fire Safety evaluation');
    expect(responsibility.holder).toBe('Fire Safety Evaluator');
    expect(responsibility.stage).toBe('Fire Safety');
    // Never the super admin, who holds every step.
    expect(responsibility.officers.map((o) => o.name)).toEqual(['Inspector Bautista']);
  });

  it('says the applicant is the one to act when it is waiting on payment', async () => {
    const admin = await officer(['super-admin']);
    const id = await file('Assessed');

    const queue = await send('GET', '/staff/applications', admin.token);
    const row = queue.json<{ items: { id: string; responsibility: { holder: string; awaitingApplicant: boolean } }[] }>()
      .items.find((candidate) => candidate.id === id);

    expect(row?.responsibility.holder).toBe('Applicant');
    expect(row?.responsibility.awaitingApplicant).toBe(true);
  });
});
