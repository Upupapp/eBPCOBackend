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
import { LifecycleStatus } from '../src/modules/applications/domain/lifecycle';

/**
 * TAB 04 — correcting and putting away a filed application.
 *
 * Two acts that look administrative and are not. An edit is how a record
 * quietly stops matching what was filed; an archive is how a live application
 * disappears from the queue that is supposed to be working it.
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
let officerId: string;
let officerToken: string;
let applicantId: string;
let applicantAccount: string;
const logLines: string[] = [];

async function staffToken(role: StaffRole): Promise<{ id: string; token: string }> {
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

/**
 * The legal moves, as the database enforces them.
 *
 * Duplicated from the transition table on purpose: a test that walked the same
 * structure the code walks would agree with it however wrong it was. This is a
 * second statement of the same rules, and the trigger refuses any step it does
 * not recognise, so the two are checked against each other on every run.
 */
const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Submitted', 'Cancelled'],
  ['Received', 'Document Verification'], ['Received', 'Cancelled'],
  ['Document Verification', 'Under Evaluation'],
  ['Document Verification', 'Revision Required'], ['Document Verification', 'Rejected'],
  ['Under Evaluation', 'Assessed'], ['Under Evaluation', 'Revision Required'],
  ['Under Evaluation', 'Rejected'],
  ['Revision Required', 'Under Evaluation'], ['Revision Required', 'Cancelled'],
  ['Revision Required', 'Expired'],
  ['Assessed', 'Payment Submitted'], ['Assessed', 'Cancelled'], ['Assessed', 'Expired'],
  ['Payment Submitted', 'Payment Under Verification'],
  ['Payment Under Verification', 'Payment Verified'],
  ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['For Approval', 'Revision Required'], ['For Approval', 'Rejected'],
  ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
  ['Ready for Release', 'Released'], ['Released', 'Completed'],
];

/** Shortest legal route from Submitted to `target`, excluding the start. */
function pathTo(target: LifecycleStatus): readonly LifecycleStatus[] {
  if (target === 'Submitted') return [];
  const queue: LifecycleStatus[][] = [['Submitted']];
  const seen = new Set<LifecycleStatus>(['Submitted']);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    for (const [from, to] of EDGES) {
      if (from !== last || seen.has(to)) continue;
      if (to === target) return [...path.slice(1), to];
      seen.add(to);
      queue.push([...path, to]);
    }
  }
  throw new Error(`no legal route to ${target}`);
}

let sequence = 0;
async function file(status: LifecycleStatus = 'Submitted'): Promise<string> {
  sequence += 1;
  const id = randomUUID();
  // Created at Submitted and then moved, because a trigger refuses an
  // application born at any other status — the LGU cannot receive one that has
  // already been assessed. Seeding around that would test a row shape the
  // database will not produce.
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, location, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','Submitted','12 Rizal Street', now(), $4)`,
    [id, `E-BPCO-2026-${String(sequence).padStart(6, '0')}`, applicantId, applicantAccount],
  );
  // Walked, not jumped. The database enforces the transition table too, so
  // `Submitted -> Under Evaluation` is refused at the trigger — as it should be.
  for (const step of pathTo(status)) {
    await db.query('update applications set lifecycle_status = $1 where id = $2', [step, id]);
  }
  return id;
}

const patch = (id: string, body: Record<string, unknown>, token = officerToken) =>
  app.inject({
    method: 'PATCH', url: `/staff/applications/${id}`,
    headers: { authorization: `Bearer ${token}` }, payload: body,
  });

const archive = (ids: string[], remarks = 'Filed away after release.', token = officerToken) =>
  app.inject({
    method: 'POST', url: '/staff/applications/archive',
    headers: { authorization: `Bearer ${token}` }, payload: { applicationIds: ids, remarks },
  });

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  ({ id: officerId, token: officerToken } = await staffToken('records-officer'));

  applicantAccount = randomUUID();
  applicantId = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [applicantAccount],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, applicantAccount],
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

describe('correcting a filed application', () => {
  it('changes a mistyped address and says what changed', async () => {
    const id = await file();

    const response = await patch(id, { location: '14 Rizal Street' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: string[] }>().changed).toEqual(['location']);
    const row = await db.query<{ location: string }>(
      'select location from applications where id = $1', [id],
    );
    expect(row.rows[0]?.location).toBe('14 Rizal Street');
  });

  it('records a before and an after, not just that something happened', async () => {
    const id = await file();
    await patch(id, { location: '99 Mabini Street' });

    const audit = await db.query<{
      actor_account_id: string; before_state: { location: string }; after_state: { location: string };
    }>(
      `select actor_account_id, before_state, after_state from audit_events
        where action = 'application.edited' order by sequence desc limit 1`,
    );
    expect(audit.rows[0]?.actor_account_id).toBe(officerId);
    expect(audit.rows[0]?.before_state.location).toBe('12 Rizal Street');
    expect(audit.rows[0]?.after_state.location).toBe('99 Mabini Street');
  });

  it('records NOTHING when the patch resends the value already there', async () => {
    // An audit chain filled with entries saying nothing happened is a chain
    // nobody reads.
    const id = await file();

    const response = await patch(id, { location: '12 Rizal Street' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: string[] }>().changed).toEqual([]);
    const audit = await db.query<{ n: string }>(
      `select count(*) as n from audit_events where action = 'application.edited' and subject_id = $1`,
      [id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(0);
  });

  it('REFUSES to set the lifecycle status, which is the transition table’s job', async () => {
    // The portal's own store offers `Partial<the whole row>`. This is the API
    // that deliberately does not.
    const id = await file();

    const response = await patch(id, { lifecycleStatus: 'Approved' });

    expect(response.statusCode).toBe(400);
    const row = await db.query<{ lifecycle_status: string }>(
      'select lifecycle_status from applications where id = $1', [id],
    );
    expect(row.rows[0]?.lifecycle_status).toBe('Submitted');
  });

  it('refuses a permit type the LGU does not issue', async () => {
    const id = await file();

    expect((await patch(id, { permitType: 'Interdimensional Portal' })).statusCode).toBe(422);
  });

  it('refuses an empty patch rather than reporting success', async () => {
    const id = await file();

    expect((await patch(id, {})).statusCode).toBe(422);
  });

  it('refuses an officer without applications:write', async () => {
    const id = await file();
    const evaluator = await staffToken('evaluator');

    expect((await patch(id, { location: 'x' }, evaluator.token)).statusCode).toBe(403);
  });
});

describe('what an assessment freezes', () => {
  const withOrderOfPayment = async (): Promise<string> => {
    const id = await file('Assessed');
    await db.query(
      `insert into orders_of_payment (application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version,
                                      assessed_at, assessed_by)
       values ($1,$2,1000,1000,0,0,0,0,2000,'v1', now(), $3)`,
      [id, `OP-${randomUUID().slice(0, 8)}`, officerId],
    );
    return id;
  };

  it('freezes the permit type once a fee has been computed from it', async () => {
    // The applicant has been told a number computed from this. Changing it
    // afterwards makes the assessment describe an application that no longer
    // exists.
    const id = await withOrderOfPayment();

    const response = await patch(id, { permitType: 'Building' });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/order of payment/i);
  });

  it('still lets a typo in the address be corrected', async () => {
    // A location change alters no computation, and refusing it would push
    // officers toward cancelling and refiling, which loses the history.
    const id = await withOrderOfPayment();

    const response = await patch(id, { location: '15 Rizal Street' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: string[] }>().changed).toEqual(['location']);
  });
});

describe('archiving, which is not cancelling', () => {
  it('REFUSES to archive an application still being processed', async () => {
    // The rule this exists for. An archived in-flight application vanishes from
    // every officer's queue while still owing an act.
    const live = await file('Under Evaluation');

    const response = await archive([live]);

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/still being processed/i);
    const row = await db.query<{ archived_at: Date | null }>(
      'select archived_at from applications where id = $1', [live],
    );
    expect(row.rows[0]?.archived_at).toBeNull();
  });

  it('archives a finished one and takes it out of the queue', async () => {
    const done = await file('Completed');
    const before = await app.inject({
      method: 'GET', url: '/staff/applications', headers: { authorization: `Bearer ${officerToken}` },
    });
    expect(before.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toContain(done);

    const response = await archive([done]);

    expect(response.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET', url: '/staff/applications', headers: { authorization: `Bearer ${officerToken}` },
    });
    expect(after.json<{ items: { id: string }[] }>().items.map((i) => i.id)).not.toContain(done);
  });

  it('still opens when an officer follows a link to it', async () => {
    // Archiving is queue visibility, not access removal. A record the LGU holds
    // stays readable by the people accountable for it.
    const done = await file('Rejected');
    await archive([done]);

    const response = await app.inject({
      method: 'GET', url: `/staff/applications/${done}`,
      headers: { authorization: `Bearer ${officerToken}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('is all or nothing when one of the batch is still live', async () => {
    // A partial archive leaves an officer guessing which of the twenty they
    // selected are still listed.
    const done = await file('Completed');
    const live = await file('Received');

    const response = await archive([done, live]);

    expect(response.statusCode).toBe(422);
    const rows = await db.query<{ n: string }>(
      'select count(*) as n from applications where archived_at is not null and id = any($1)',
      [[done, live]],
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('writes one audit entry per application, not one for the batch', async () => {
    // The chain answers questions about a subject. A single entry listing
    // twenty ids answers none of them without a text search.
    const first = await file('Completed');
    const second = await file('Cancelled');

    await archive([first, second], 'Year-end tidy-up.');

    const audit = await db.query<{ subject_id: string; after_state: { remarks: string } }>(
      `select subject_id, after_state from audit_events where action = 'application.archived'
        order by sequence desc limit 2`,
    );
    expect(audit.rows.map((r) => r.subject_id).sort()).toEqual([first, second].sort());
    expect(audit.rows[0]?.after_state.remarks).toBe('Year-end tidy-up.');
  });

  it('requires remarks, so an archive can be explained', async () => {
    const done = await file('Expired');

    const response = await app.inject({
      method: 'POST', url: '/staff/applications/archive',
      headers: { authorization: `Bearer ${officerToken}` },
      payload: { applicationIds: [done] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('is idempotent: archiving an already-archived one changes nothing and does not fail', async () => {
    const done = await file('Completed');
    await archive([done]);

    const again = await archive([done], 'Second pass.');

    expect(again.statusCode).toBe(200);
    expect(again.json<{ archived: string[] }>().archived).toEqual([]);
    const row = await db.query<{ archive_remarks: string }>(
      'select archive_remarks from applications where id = $1', [done],
    );
    expect(row.rows[0]?.archive_remarks).toBe('Filed away after release.');
  });

  it('refuses when one of the ids does not exist', async () => {
    const done = await file('Completed');

    expect((await archive([done, randomUUID()])).statusCode).toBe(404);
  });
});

describe("the evaluator's worklist", () => {
  const evaluate = async (
    id: string, stage: string, result: string, token: string, remarks?: string,
  ) => app.inject({
    method: 'POST', url: `/staff/applications/${id}/evaluations`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { stage, result, ...(remarks === undefined ? {} : { remarks }) },
  });

  const queue = async (query = '', token = ''): Promise<{
    items: {
      applicationId: string; nextStage: string | null; lifecycleStatus: string;
      requiredDocumentCount: number; attachedDocumentCount: number;
      evaluations: { stage: string }[];
    }[];
    nextCursor: string | null;
  }> => {
    const evaluator = token === '' ? (await staffToken('evaluator')).token : token;
    const response = await app.inject({
      method: 'GET', url: `/staff/evaluations${query}`,
      headers: { authorization: `Bearer ${evaluator}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  it('lists applications in evaluation with the stage each is waiting on', async () => {
    const id = await file('Under Evaluation');

    const page = await queue();

    const row = page.items.find((item) => item.applicationId === id);
    expect(row).toBeDefined();
    expect(row?.nextStage).toBe('Initial');
  });

  it('keeps an evaluated application visible to someone entitled to see it', async () => {
    // The `or exists(evaluations)` half of the filter: an application that has
    // moved past the evaluation statuses is still part of the evaluation
    // record, and an officer who can see it should find it here.
    const id = await file('Under Evaluation');
    const evaluator = await staffToken('evaluator');
    await evaluate(id, 'Initial', 'Passed', evaluator.token);
    await db.query("update applications set lifecycle_status = 'Assessed' where id = $1", [id]);

    // A super-admin, which is the role that holds BOTH `applications:read` and
    // a visibility of 'all'. An `administrator` holds only `staff:administer`
    // and is refused at the scope guard — administering accounts is not reading
    // applications, which is the separation TAB 00 settled and this confirms.
    const page = await queue('', (await staffToken('super-admin')).token);

    const row = page.items.find((item) => item.applicationId === id);
    expect(row?.lifecycleStatus).toBe('Assessed');
    expect(row?.evaluations.map((e) => e.stage)).toEqual(['Initial']);
    expect(row?.nextStage).toBe('Zoning');
  });

  it('HIDES IT FROM THE EVALUATOR WHO PASSED IT, once it moves beyond their reach', async () => {
    // My own expectation was wrong here before the test was written: I assumed
    // an evaluator should keep seeing what they cleared. Scope visibility says
    // otherwise — `staff:evaluate` stops at Revision Required — and the rule
    // that decides what an officer may READ is not something a convenience
    // queue gets to override.
    const id = await file('Under Evaluation');
    const evaluator = await staffToken('evaluator');
    await evaluate(id, 'Initial', 'Passed', evaluator.token);
    await db.query("update applications set lifecycle_status = 'Assessed' where id = $1", [id]);

    const page = await queue('', evaluator.token);

    expect(page.items.map((i) => i.applicationId)).not.toContain(id);
  });

  it('filters by the stage an application is waiting on', async () => {
    const waiting = await file('Under Evaluation');
    const advanced = await file('Under Evaluation');
    const evaluator = await staffToken('evaluator');
    await evaluate(advanced, 'Initial', 'Passed', evaluator.token);

    const page = await queue('?stage=Zoning');

    expect(page.items.map((i) => i.applicationId)).toContain(advanced);
    expect(page.items.map((i) => i.applicationId)).not.toContain(waiting);
  });

  it('filters by result', async () => {
    const passed = await file('Under Evaluation');
    const returned = await file('Under Evaluation');
    const evaluator = await staffToken('evaluator');
    await evaluate(passed, 'Initial', 'Passed', evaluator.token);
    await evaluate(returned, 'Initial', 'Revision Required', evaluator.token,
      'Sheet S-3 bears no signature.');

    const page = await queue('?result=Revision%20Required');

    expect(page.items.map((i) => i.applicationId)).toEqual([returned]);
  });

  it('narrows to what this officer has evaluated', async () => {
    const mine = await file('Under Evaluation');
    const theirs = await file('Under Evaluation');
    const me = await staffToken('evaluator');
    const other = await staffToken('evaluator');
    await evaluate(mine, 'Initial', 'Passed', me.token);
    await evaluate(theirs, 'Initial', 'Passed', other.token);

    const page = await queue('?evaluatedByMe=true', me.token);

    expect(page.items.map((i) => i.applicationId)).toEqual([mine]);
  });

  it('REPORTS BOTH DOCUMENT COUNTS AND NEVER THE DIFFERENCE', async () => {
    // Nothing links an uploaded document to the requirement it satisfies —
    // `documents.label` is free text — so a "missing" count would be a guess
    // that silently mis-reports whether an applicant has complied.
    const id = await file('Under Evaluation');
    await db.query(
      `update applications set required_documents = $1 where id = $2`,
      [JSON.stringify([
        { code: 'lot-plan', label: 'Lot Plan', description: '', required: true },
        { code: 'photos', label: 'Photos', description: '', required: false },
      ]), id],
    );

    const row = (await queue()).items.find((item) => item.applicationId === id);

    // Only the REQUIRED ones are counted, and the optional one is not.
    expect(row?.requiredDocumentCount).toBe(1);
    expect(row?.attachedDocumentCount).toBe(0);
    expect(row).not.toHaveProperty('missingDocumentCount');
  });

  it('excludes an archived application, like every other queue', async () => {
    const id = await file('Completed');
    const evaluator = await staffToken('evaluator');
    await evaluate(id, 'Initial', 'Passed', evaluator.token).catch(() => undefined);
    await archive([id]);

    expect((await queue()).items.map((i) => i.applicationId)).not.toContain(id);
  });

  it('shows a cashier nothing, because scope decides what an officer may read', async () => {
    const underEvaluation = await file('Under Evaluation');
    const cashier = await staffToken('cashier');

    const response = await app.inject({
      method: 'GET', url: '/staff/evaluations',
      headers: { authorization: `Bearer ${cashier.token}` },
    });

    // A cashier's visibility starts at Assessed, so an application still under
    // evaluation is not theirs to read. Asserted on THIS application rather
    // than on an empty page: this suite shares one database across its tests,
    // so a global emptiness check would be measuring what earlier tests left
    // behind rather than the rule.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { applicationId: string }[] }>().items.map((i) => i.applicationId))
      .not.toContain(underEvaluation);
  });
});
