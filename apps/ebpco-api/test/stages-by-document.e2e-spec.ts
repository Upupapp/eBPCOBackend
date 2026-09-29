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
import { scopesFor } from '../src/modules/identity/domain/account';
import { RequirementsService } from '../src/modules/applications/application/requirements.service';
import { retiredPermitDetail } from '../src/modules/applications/application/submission.service';
import {
  EVALUATION_STAGES, EvaluationStage, stagesForChecklist,
} from '../src/modules/applications/domain/evaluation-stages';
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * Stages by document (migration 060): an application goes through a stage only
 * when a required document on its checklist is checked there. The owner's
 * example: a Fencing Permit has nothing for the Bureau of Fire Protection to
 * check, so it never waits on the Fire Safety stage.
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
let requirements: RequirementsService;
let applicantId: string;
let evaluatorToken: string;
let evaluatorAccount: string;
const APPLICANT_ACCOUNT = randomUUID();

const PATH: readonly LifecycleStatus[] = ['Submitted', 'Received', 'Document Verification', 'Under Evaluation'];

/** Filed the way the service files: the checklist snapshotted onto the application. */
async function file(
  permitType: string, action: 'New' | 'Renewal' | 'Amendment' = 'New', { accepted = true } = {},
): Promise<string> {
  const checklist = await requirements.forPermitType(permitType, action);
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by, required_documents)
     values ($1,$2,$3,$4,$5,'Submitted',now(),$6,$7)`,
    [id, `T-${id.slice(0, 6)}`, applicantId, permitType, action, APPLICANT_ACCOUNT, JSON.stringify(checklist)],
  );
  for (const next of PATH.slice(1)) {
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
  }
  // Every required document uploaded; accepted by the office unless a test says not, since a stage
  // passes only on the documents it checks (2026-09-30).
  for (const document of checklist.filter((entry) => entry.required)) {
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type, byte_size, sha256,
                              storage_key, status, scan_cleared, requirement_code, review_status, reviewed_at,
                              reviewed_by)
       values ($1,$2,$3,$4,$5,'application/pdf',1024,$6,$7,'Approved',true,$8,$9,$10,$11)`,
      [randomUUID(), id, APPLICANT_ACCOUNT, document.label, `${document.code}.pdf`,
        randomUUID().replace(/-/g, '').padEnd(64, '0'), `objects/${randomUUID()}.pdf`, document.code,
        accepted ? 'Accepted' : null, accepted ? new Date() : null, accepted ? evaluatorAccount : null],
    );
  }
  return id;
}

const decide = (applicationId: string, stage: EvaluationStage) =>
  app.inject({
    method: 'POST', url: `/staff/applications/${applicationId}/evaluations`,
    headers: { authorization: `Bearer ${evaluatorToken}`, 'idempotency-key': randomUUID() },
    payload: { stage, result: 'Passed' },
  });

const nextStage = async (applicationId: string): Promise<string | null> => {
  const { rows } = await db.query<{ stage: string | null }>(
    `select (select s.stage from unnest(application_evaluation_stages(a.required_documents))
                          with ordinality as s(stage, ord)
              where not exists (select 1 from evaluations e where e.application_id = a.id
                                  and e.stage = s.stage and e.result = 'Passed')
              order by s.ord limit 1) as stage
       from applications a where a.id = $1`, [applicationId]);
  return rows[0]?.stage ?? null;
};

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  requirements = new RequirementsService(db);

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

  // An evaluator holding every stage, so only the stage rules are under test.
  const evaluator = randomUUID();
  evaluatorAccount = evaluator;
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff','eval@lgu.gov.ph','eval@lgu.gov.ph','scrypt$1$1$1$a$b')`, [evaluator]);
  await db.query("insert into account_roles (account_id, role) values ($1,'evaluator')", [evaluator]);
  await db.query("insert into staff_access (account_id, level, assigned_by) values ($1,'view-edit',$1)", [evaluator]);
  await db.query(
    'insert into staff_permit_access (account_id, permit_type, granted_by) select $1, permit_type, $1 from permit_types',
    [evaluator]);
  for (const stage of EVALUATION_STAGES) {
    await db.query('insert into staff_evaluation_stages (account_id, stage, granted_by) values ($1,$2,$1)', [evaluator, stage]);
  }
  evaluatorToken = (await tokens.issueAccessToken({
    sub: evaluator, sid: randomUUID(), kind: 'staff', scopes: [...scopesFor({ kind: 'staff', roles: ['evaluator'] })],
  })).token;
});

afterEach(async () => {
  await app.close();
});

describe('which stages each permit goes through', () => {
  it('sends a Building Permit through all five stages', async () => {
    expect(stagesForChecklist(await requirements.forPermitType('Building Permit', 'New')))
      .toEqual(['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval']);
  });

  it('asks every Building Permit for the FSEC — renovation and addition too', async () => {
    for (const action of ['Renewal', 'Amendment'] as const) {
      const checklist = await requirements.forPermitType('Building Permit', action);
      expect(checklist.find((document) => document.code === 'fsec'))
        .toMatchObject({ required: true, stage: 'Fire Safety' });
      expect(stagesForChecklist(checklist)).toContain('Fire Safety');
    }
  });

  it('skips Fire Safety for the permits the BFP has nothing to check on', async () => {
    for (const permit of [
      'Fencing Permit', 'Sign Permit', 'Demolition Permit', 'Excavation Permit', 'Electrical Permit',
      'Architectural Permit', 'Civil / Structural Permit', 'Mechanical Permit', 'Plumbing Permit',
      'Sanitary Permit', 'Electronics Permit', 'Interior Design Permit',
    ]) {
      expect({ permit, stages: stagesForChecklist(await requirements.forPermitType(permit, 'New')) })
        .toEqual({ permit, stages: ['Initial', 'Zoning', 'OBO', 'Final Approval'] });
    }
  });

  it('sends a Certificate of Occupancy to Fire Safety for the FSIC', async () => {
    const checklist = await requirements.forPermitType('Certificate of Occupancy', 'New');
    expect(checklist.find((document) => document.code === 'coo-fsic')?.stage).toBe('Fire Safety');
    expect(stagesForChecklist(checklist)).toEqual(['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval']);
  });

  it('keeps a Zoning / Locational Clearance with the MPDO: no Fire Safety, no OBO', async () => {
    expect(stagesForChecklist(await requirements.forPermitType('Zoning / Locational Clearance', 'New')))
      .toEqual(['Initial', 'Zoning', 'Final Approval']);
  });

  it('says where the FSEC comes from on the checklist itself', async () => {
    const checklist = await requirements.forPermitType('Building Permit', 'New');
    expect(checklist.find((document) => document.code === 'bpnc-fire-safety-clearance')?.description)
      .toContain('fsis.e-bfp.com');
  });
});

describe('the database and the service agree on the stages', () => {
  it.each([
    ['a checklist from before stages existed', [{ code: 'x', required: true }]],
    ['an empty checklist', []],
    ['a checklist with only optional documents at Zoning', [
      { code: 'a', required: true, stage: 'Initial' }, { code: 'b', required: false, stage: 'Zoning' }]],
    ['a Fencing-shaped checklist', [
      { code: 'a', required: true, stage: 'Initial' }, { code: 'b', required: true, stage: 'Zoning' },
      { code: 'c', required: true, stage: 'OBO' }]],
  ])('%s', async (_name, checklist) => {
    const { rows } = await db.query<{ stages: string[] }>(
      'select application_evaluation_stages($1::jsonb) as stages', [JSON.stringify(checklist)]);
    expect(rows[0]!.stages).toEqual([...stagesForChecklist(checklist)]);
  });
});

describe('evaluating an application with fewer stages', () => {
  it('takes a Fencing Permit from Zoning straight to OBO, and completes without Fire Safety', async () => {
    const fence = await file('Fencing Permit');

    expect((await decide(fence, 'Initial')).statusCode).toBe(201);
    expect((await decide(fence, 'Zoning')).statusCode).toBe(201);
    expect(await nextStage(fence)).toBe('OBO');

    const fire = await decide(fence, 'Fire Safety');
    expect(fire.statusCode).toBe(409);
    expect(fire.json<{ detail: string }>().detail).toMatch(/does not go through the Fire Safety stage/);

    expect((await decide(fence, 'OBO')).statusCode).toBe(201);
    const last = await decide(fence, 'Final Approval');
    expect(last.statusCode).toBe(201);
    expect(last.json<{ evaluationsComplete: boolean }>().evaluationsComplete).toBe(true);
    expect(await nextStage(fence)).toBeNull();
  });

  it('refuses to pass Fire Safety until the BFP clearance is accepted, and says which document', async () => {
    const building = await file('Building Permit', 'New', { accepted: false });
    await db.query(
      `update documents set review_status = 'Accepted', reviewed_at = now(), reviewed_by = $2
        where application_id = $1 and requirement_code <> 'bpnc-fire-safety-clearance'`,
      [building, evaluatorAccount]);
    expect((await decide(building, 'Initial')).statusCode).toBe(201);
    expect((await decide(building, 'Zoning')).statusCode).toBe(201);

    const refused = await decide(building, 'Fire Safety');
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ detail: string }>().detail).toMatch(/Fire Safety Evaluation Clearance.*\(not yet reviewed\)/);

    await db.query(
      `update documents set review_status = 'Accepted', reviewed_at = now(), reviewed_by = $2
        where application_id = $1 and requirement_code = 'bpnc-fire-safety-clearance'`,
      [building, evaluatorAccount]);
    expect((await decide(building, 'Fire Safety')).statusCode).toBe(201);
  });

  it('shows the queue the stages and the next one', async () => {
    const fence = await file('Fencing Permit');
    await decide(fence, 'Initial');
    await decide(fence, 'Zoning');

    const queue = await app.inject({
      method: 'GET', url: '/staff/applications', headers: { authorization: `Bearer ${evaluatorToken}` },
    });
    const row = queue.json<{ items: { id: string; evaluationStage: string; evaluationStages: string[] }[] }>()
      .items.find((item) => item.id === fence)!;
    expect(row.evaluationStage).toBe('OBO');
    expect(row.evaluationStages).toEqual(['Initial', 'Zoning', 'OBO', 'Final Approval']);
  });

  it('leaves an application filed before stages existed on all five', async () => {
    const legacy = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'OLD-1',$2,'Fencing Permit','New','Submitted',now(),$3)`,
      [legacy, applicantId, APPLICANT_ACCOUNT]);
    for (const next of PATH.slice(1)) {
      await db.query('update applications set lifecycle_status = $1 where id = $2', [next, legacy]);
    }
    await decide(legacy, 'Initial');
    await decide(legacy, 'Zoning');

    expect(await nextStage(legacy)).toBe('Fire Safety');
  });
});

describe('the BFP issues its own clearances', () => {
  it('retires the FSEC and FSIC permit types, keeping them on record', async () => {
    const { rows } = await db.query<{ permit_type: string; retired: boolean }>(
      `select permit_type, retired_at is not null as retired from permit_types
        where permit_type like '%(BFP)' order by permit_type`);
    expect(rows).toEqual([
      { permit_type: 'FSEC for Building Permit (BFP)', retired: true },
      { permit_type: 'FSIC for Occupancy Permit (BFP)', retired: true },
    ]);
  });

  it('tells an applicant who tries to file one where to go instead', () => {
    expect(retiredPermitDetail('FSEC for Building Permit (BFP)')).toMatch(/BFP-FSIS \(fsis\.e-bfp\.com\)/);
    expect(retiredPermitDetail('Old Permit')).toMatch(/no longer issues/);
  });
});
