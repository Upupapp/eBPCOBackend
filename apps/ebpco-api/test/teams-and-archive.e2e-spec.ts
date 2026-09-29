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
import { scopesFor, StaffRole } from '../src/modules/identity/domain/account';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * A lead and members for every office, and archive -- never delete -- for
 * everything (owner request, 2026-09-29).
 *
 * Every officer reads every application; an officer works on one only while
 * it is at their team's step, and once it is assigned only if it is theirs --
 * the lead excepted, who also assigns.
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

jest.setTimeout(40_000);

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let applicantId: string;
const CITIZEN = randomUUID();

interface Officer { id: string; token: string }

async function officer(
  name: string, roles: StaffRole[], stages: string[] = [], teamRole: 'lead' | 'member' = 'member',
): Promise<Officer> {
  const id = randomUUID();
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@lgu.gov.ph`;
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, full_name)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b',$3)`, [id, email, name]);
  for (const role of roles) await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  await db.query(
    "insert into staff_access (account_id, level, assigned_by, team_role) values ($1,'view-edit',$1,$2)", [id, teamRole]);
  await db.query(
    'insert into staff_permit_access (account_id, permit_type, granted_by) select $1, permit_type, $1 from permit_types',
    [id]);
  for (const stage of stages) {
    await db.query('insert into staff_evaluation_stages (account_id, stage, granted_by) values ($1,$2,$1)', [id, stage]);
  }
  const token = (await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff', scopes: [...scopesFor({ kind: 'staff', roles })],
  })).token;
  return { id, token };
}

async function application(status: LifecycleStatus): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing Permit','New','Submitted',now(),$4)`,
    [id, `BP-${id.slice(0, 6)}`, applicantId, CITIZEN]);
  for (const next of ['Received', 'Document Verification', 'Under Evaluation'] as const) {
    if (status === 'Submitted') break;
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    if (next === status) break;
  }
  return id;
}

const send = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Officer, payload?: unknown) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${who.token}`, 'idempotency-key': randomUUID() },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const assigneeOf = async (applicationId: string, team: string): Promise<string | null> =>
  (await db.query<{ assigned_to: string }>(
    'select assigned_to from application_assignments where application_id = $1 and team = $2',
    [applicationId, team])).rows[0]?.assigned_to ?? null;

let lead: Officer;
let ana: Officer;
let ben: Officer;
let zoning: Officer;
let records: Officer;
let superAdmin: Officer;

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`, [CITIZEN]);
  applicantId = randomUUID();
  await db.query(
    "insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')",
    [applicantId, CITIZEN]);

  lead = await officer('Patricia Robles', ['evaluator'], ['Initial'], 'lead');
  ana = await officer('Ana Cruz', ['evaluator'], ['Initial']);
  ben = await officer('Ben Reyes', ['evaluator'], ['Initial']);
  zoning = await officer('Dennis Gonzaga', ['evaluator'], ['Zoning'], 'lead');
  records = await officer('Joel Dimaano', ['records-officer']);
  superAdmin = await officer('Paul Admin', ['super-admin']);
});

afterEach(async () => {
  await app.close();
});

describe('every officer reads every application', () => {
  it('lets the Zoning Officer open one still at the Initial step', async () => {
    const id = await application('Document Verification');
    expect((await send('GET', `/staff/applications/${id}`, zoning)).statusCode).toBe(200);
    const list = await send('GET', '/staff/applications', zoning);
    expect(list.json<{ items: { id: string }[] }>().items.map((row) => row.id)).toContain(id);
  });
});

describe('working on an application only at your team’s step', () => {
  it('refuses the Zoning Officer an application at the Initial step, and says whose it is', async () => {
    const id = await application('Document Verification');

    const edit = await send('PATCH', `/staff/applications/${id}`, zoning, { location: 'Lot 5, Poblacion' });
    expect(edit.statusCode).toBe(403);
    expect(edit.json<{ reason: string; detail: string }>()).toMatchObject({ reason: 'not-your-stage' });
    expect(edit.json<{ detail: string }>().detail).toMatch(/Initial Evaluation team/);

    const move = await send('POST', `/staff/applications/${id}/transitions`, zoning, { to: 'Under Evaluation' });
    expect(move.statusCode).toBe(403);
  });

  it('lets the Initial team edit it and move it on', async () => {
    const id = await application('Document Verification');
    expect((await send('PATCH', `/staff/applications/${id}`, ana, { location: 'Lot 5, Poblacion' })).statusCode).toBe(200);
    // Past the step guard: what answers now is the lifecycle's own
    // precondition (its documents are not verified), not "not your stage".
    const move = await send('POST', `/staff/applications/${id}/transitions`, ana, { to: 'Under Evaluation' });
    expect(move.statusCode).toBe(422);
    expect(move.json<{ detail: string }>().detail).not.toMatch(/team/);
    expect((await send('POST', `/staff/applications/${id}/transitions`, ana, { to: 'Revision Required', remarks: 'Unsigned plans' }))
      .statusCode).toBe(200);
  });

  it('keeps the Records Officer’s record-keeping at any step', async () => {
    const id = await application('Under Evaluation');
    expect((await send('PATCH', `/staff/applications/${id}`, records, { location: 'Lot 7' })).statusCode).toBe(200);
  });
});

describe('a team lead and team members', () => {
  it('gives an unassigned application to the first member who works on it', async () => {
    const id = await application('Under Evaluation');

    expect((await send('PATCH', `/staff/applications/${id}`, ana, { location: 'Lot 5' })).statusCode).toBe(200);
    expect(await assigneeOf(id, 'initial-evaluation')).toBe(ana.id);

    const other = await send('POST', `/staff/applications/${id}/evaluations`, ben, { stage: 'Initial', result: 'Passed' });
    expect(other.statusCode).toBe(403);
    expect(other.json<{ reason: string; detail: string }>().reason).toBe('assigned-to-other');
    expect(other.json<{ detail: string }>().detail).toMatch(/assigned to Ana Cruz/);
  });

  it('lets the lead work on anything at the team’s step', async () => {
    const id = await application('Under Evaluation');
    await send('PATCH', `/staff/applications/${id}`, ana, { location: 'Lot 5' });

    const decided = await send('POST', `/staff/applications/${id}/evaluations`, lead, { stage: 'Initial', result: 'Passed' });
    expect(decided.statusCode).toBe(201);
  });

  it('lets the lead reassign, and the new assignee then works on it', async () => {
    const id = await application('Under Evaluation');
    await send('PATCH', `/staff/applications/${id}`, ana, { location: 'Lot 5' });

    const moved = await send('POST', `/staff/applications/${id}/assignment`, lead, { assigneeId: ben.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ detail: string }>().detail).toMatch(/now with Ben Reyes/);

    expect((await send('PATCH', `/staff/applications/${id}`, ana, { location: 'Lot 6' })).statusCode).toBe(403);
    expect((await send('POST', `/staff/applications/${id}/evaluations`, ben, { stage: 'Initial', result: 'Passed' }))
      .statusCode).toBe(201);
  });

  it('lets a member take an unassigned one, but only the lead give one to someone else', async () => {
    const id = await application('Under Evaluation');

    const handOff = await send('POST', `/staff/applications/${id}/assignment`, ana, { assigneeId: ben.id });
    expect(handOff.statusCode).toBe(403);

    expect((await send('POST', `/staff/applications/${id}/assignment`, ana, { assigneeId: ana.id })).statusCode).toBe(200);
    const snatch = await send('POST', `/staff/applications/${id}/assignment`, ben, { assigneeId: ben.id });
    expect(snatch.statusCode).toBe(409);
    expect(snatch.json<{ detail: string }>().detail).toMatch(/already with Ana Cruz/);
  });

  it('will not give it to someone outside the team', async () => {
    const id = await application('Under Evaluation');
    const outsider = await send('POST', `/staff/applications/${id}/assignment`, lead, { assigneeId: zoning.id });
    expect(outsider.statusCode).toBe(409);
  });

  it('shows each team, its lead first, and the work waiting on it', async () => {
    const waiting = await application('Under Evaluation');
    await application('Document Verification');
    await send('POST', `/staff/applications/${waiting}/assignment`, lead, { assigneeId: ana.id });

    const teams = (await send('GET', '/staff/teams', ana)).json<{ data: {
      key: string; waiting: number; unassigned: number; members: { name: string; lead: boolean; assigned: number }[];
    }[] }>().data;
    const initial = teams.find((team) => team.key === 'initial-evaluation')!;
    expect(initial.members.map((m) => m.name)).toEqual(['Patricia Robles', 'Ana Cruz', 'Ben Reyes']);
    expect(initial.members[0]!.lead).toBe(true);
    expect(initial).toMatchObject({ waiting: 2, unassigned: 1 });
    expect(initial.members.find((m) => m.name === 'Ana Cruz')!.assigned).toBe(1);
  });

  it('tells the signed-in officer their team and whether they lead it', async () => {
    const me = (await send('GET', '/me', lead)).json<{ teams: string[]; teamRole: string }>();
    expect(me).toMatchObject({ teams: ['initial-evaluation'], teamRole: 'lead' });
  });
});

describe('archive, never delete', () => {
  it('archives a staff account that never acted, rather than deleting it, and restores it', async () => {
    const archived = await send('DELETE', `/staff/users/${ben.id}`, superAdmin, { reason: 'Transferred to the MPDO' });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ mode: string }>().mode).toBe('archived');
    const row = await db.query<{ removed_reason: string }>('select removed_reason from accounts where id = $1', [ben.id]);
    expect(row.rows[0]?.removed_reason).toBe('Transferred to the MPDO');

    const listed = (await send('GET', '/staff/archive', superAdmin)).json<{ data: { kind: string; id: string; reason: string }[] }>();
    expect(listed.data).toContainEqual(expect.objectContaining({ kind: 'staff', id: ben.id, reason: 'Transferred to the MPDO' }));

    expect((await send('POST', `/staff/archive/staff/${ben.id}/restore`, records)).statusCode).toBe(403);
    expect((await send('POST', `/staff/archive/staff/${ben.id}/restore`, superAdmin)).statusCode).toBe(200);
    const back = await db.query<{ removed_at: Date | null; disabled_at: Date | null }>(
      'select removed_at, disabled_at from accounts where id = $1', [ben.id]);
    expect(back.rows[0]).toEqual({ removed_at: null, disabled_at: null });
  });

  it('archives and restores a business, keeping it out of the working list meanwhile', async () => {
    const business = randomUUID();
    await db.query(
      `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                               province, registration_number, date_registered, status)
       values ($1,$2,'Santos Store','Retail','12 Rizal Street','Poblacion','Castilla','Sorsogon','BN-1','2024-03-01','Active')`,
      [business, applicantId]);

    const archived = await send('POST', `/staff/archive/business/${business}`, records, { reason: 'Closed in 2025' });
    expect(archived.statusCode).toBe(200);
    const list = (await send('GET', '/staff/businesses', records)).json<{ data: { id: string }[] }>();
    expect(list.data.map((b) => b.id)).not.toContain(business);

    expect((await send('POST', `/staff/archive/business/${business}/restore`, records)).statusCode).toBe(200);
    const again = (await send('GET', '/staff/businesses', records)).json<{ data: { id: string }[] }>();
    expect(again.data.map((b) => b.id)).toContain(business);
  });

  it('will not archive a citizen with an application still being processed', async () => {
    await application('Under Evaluation');
    const refused = await send('POST', `/staff/archive/citizen/${CITIZEN}`, superAdmin, { reason: 'Duplicate account' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ detail: string }>().detail).toMatch(/still being processed/);
  });

  it('archives a checklist document it is saved without, and restores it', async () => {
    const before = (await send('GET', '/staff/config/requirements/Fencing%20Permit', superAdmin))
      .json<{ documents: { code: string; label: string; required: boolean; stage?: string }[] }>().documents;
    const dropped = before[before.length - 1]!;

    const saved = await send('PUT', '/staff/config/requirements/Fencing%20Permit', superAdmin, {
      documents: before.slice(0, -1),
    });
    expect(saved.statusCode).toBe(200);
    const archived = await db.query<{ id: string }>(
      "select id from document_requirements where permit_type = 'Fencing Permit' and code = $1 and archived_at is not null",
      [dropped.code]);
    expect(archived.rows).toHaveLength(1);

    expect((await send('POST', `/staff/archive/requirement/${archived.rows[0]!.id}/restore`, superAdmin)).statusCode)
      .toBe(200);
    const after = (await send('GET', '/staff/config/requirements/Fencing%20Permit', superAdmin))
      .json<{ documents: { code: string }[] }>().documents;
    expect(after.map((d) => d.code)).toContain(dropped.code);
  });
});
