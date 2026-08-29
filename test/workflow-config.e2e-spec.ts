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
 * D-5 — editing the lifecycle over HTTP.
 *
 * The assertions that matter are not that a row was written. They are that the
 * edit CHANGED WHAT THE SERVER DOES: a move made narrower is refused to an
 * officer who could make it a minute earlier, and a move made wider is allowed
 * to one who could not. Until D-5 the transition rules were compiled in, so a
 * test that only round-tripped JSON would pass identically against a server
 * that stored the edit and ignored it.
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
  RATE_LIMIT_MAX: '10000',
};

interface WireTransition {
  from: LifecycleStatus;
  to: LifecycleStatus;
  actors: readonly ('applicant' | 'staff')[];
  requiresScope: string;
  preconditions: readonly string[];
  notifies: string | null;
}

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let adminToken: string;
let clerkToken: string;
let applicantId: string;
let applicantAccount: string;
let seeded: Record<string, unknown>[];
/** The id of the account `staffAccount` most recently created. */
let lastAccountId: string;
/** An archive entry with no actor is refused by the schema, and rightly. */
let archivistId: string;
let adminAccountId: string;
const logLines: string[] = [];

async function staffAccount(role: StaffRole): Promise<string> {
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
  lastAccountId = id;
  return issued.token;
}

const send = (
  method: 'GET' | 'POST' | 'PUT', url: string, token: string,
  payload?: Record<string, unknown>, headers: Record<string, string> = {},
) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });

/** The rules as the server currently applies them. */
async function currentRules(): Promise<WireTransition[]> {
  const response = await send('GET', '/staff/config/workflow', clerkToken);
  expect(response.statusCode).toBe(200);
  return response.json<{ transitions: WireTransition[] }>().transitions;
}

/**
 * Edits one move the way the portal would: `roles` is derived from the scope, so
 * an editor changing the scope drops it rather than sending a list that no
 * longer follows. The endpoint refuses the stale pairing, which is its own test
 * below.
 */
const withRule = (
  rules: readonly WireTransition[], from: LifecycleStatus, to: LifecycleStatus,
  change: Partial<WireTransition>,
): Record<string, unknown>[] =>
  rules.map((rule) => {
    if (rule.from !== from || rule.to !== to) return { ...rule };
    const { roles: _derived, ...rest } = { ...rule, ...change } as WireTransition
      & { roles?: string[] };
    return rest;
  });

/**
 * Walked forward rather than inserted at the target status: the database
 * refuses an application created anywhere but the start of the lifecycle, and
 * rightly -- a row that appears mid-flow has no history explaining how it got
 * there.
 */
const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'],
];

async function file(target: LifecycleStatus): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','Submitted',now(),$4)`,
    [id, `EB-${id.slice(0, 8)}`, applicantId, applicantAccount],
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

const move = (applicationId: string, to: LifecycleStatus, token: string) =>
  send('POST', `/staff/applications/${applicationId}/transitions`, token, { to },
    { 'idempotency-key': randomUUID() });

/**
 * One database for the file, not one per test.
 *
 * These tests EDIT the transition table, so they do need isolation from each
 * other -- but a fresh PGlite plus 29 migrations per test is a whole database
 * build to undo two writes. Run in the full suite that cost 19 minutes and
 * starved every other worker; the same file alone takes ten seconds. The state
 * these tests actually dirty is restored in afterEach instead.
 */
beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  adminToken = await staffAccount('administrator');
  adminAccountId = lastAccountId;
  clerkToken = await staffAccount('records-officer');
  archivistId = lastAccountId;

  applicantAccount = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant',$2,$2,'scrypt$1$1$1$a$b')`,
    [applicantAccount, `owner-${applicantAccount.slice(0, 8)}@example.ph`],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, applicantAccount],
  );

  // The seeded lifecycle, kept verbatim so each test starts from the rules the
  // migration wrote rather than from whatever the previous test left behind.
  seeded = (await db.query<Record<string, unknown>>(
    'select * from lifecycle_transitions order by ordinal')).rows;
}, 60_000);

afterEach(async () => {
  await db.query('delete from staff_notifications');
  await db.query('delete from lifecycle_transitions');
  for (const row of seeded) {
    await db.query(
      `insert into lifecycle_transitions
         (from_status, to_status, actors, requires_scope, preconditions, notifies, ordinal)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [row['from_status'], row['to_status'], row['actors'], row['requires_scope'],
       row['preconditions'], row['notifies'], row['ordinal']],
    );
  }

  // Archived rather than deleted: the live-stranding refusal counts unarchived
  // applications, and deleting a row that history and audit entries point at is
  // a fight with the schema for no gain here.
  await db.query(
    `update applications
        set archived_at = now(), archived_by = $1,
            archive_remarks = 'test fixture cleanup'
      where archived_at is null`,
    [archivistId],
  );

  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  if (failures.length > 0) {
    throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
  }
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('who may edit the lifecycle', () => {
  it('refuses an officer without staff:administer', async () => {
    // The records officer can READ the workflow -- the portal draws it for
    // everyone. Editing it is a different act.
    const response = await send('PUT', '/staff/config/workflow', clerkToken,
      { transitions: await currentRules() });

    expect(response.statusCode).toBe(403);
  });

  it('accepts an administrator, and reports nothing given up when nothing changed', async () => {
    const response = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: await currentRules() });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ controlsGivenUp: string[] }>().controlsGivenUp).toEqual([]);
  });
});

describe('the edit changes what the server does', () => {
  it('refuses a move the officer could make before it was narrowed', async () => {
    const application = await file('Submitted');
    // Proves the starting state rather than assuming it: without this, a server
    // that refused for some unrelated reason would read as a passing test.
    expect((await move(await file('Submitted'), 'Received', clerkToken)).statusCode).toBe(200);

    const narrowed = withRule(await currentRules(), 'Submitted', 'Received',
      { requiresScope: 'staff:approve' });
    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: narrowed }))
      .statusCode).toBe(200);

    const refused = await move(application, 'Received', clerkToken);
    expect(refused.statusCode).toBe(403);
  });

  it('allows a move the officer could not make before it was widened', async () => {
    const application = await file('Document Verification');
    expect((await move(await file('Document Verification'), 'Rejected', clerkToken))
      .statusCode).toBe(403);

    const widened = withRule(await currentRules(), 'Document Verification', 'Rejected',
      { requiresScope: 'applications:write' });
    const saved = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: widened });

    expect(saved.statusCode).toBe(200);
    // The point of D-5's compromise: permitted, and named back to the caller.
    expect(saved.json<{ controlsGivenUp: string[] }>().controlsGivenUp).toEqual([
      'Document Verification -> Rejected now needs only applications:write instead of '
      + 'staff:approve, so more officers can make it.',
    ]);
    expect((await move(application, 'Rejected', clerkToken)).statusCode).toBe(200);
  });

  it('records the change, with what it gave up, in the audit log', async () => {
    const widened = withRule(await currentRules(), 'Document Verification', 'Rejected',
      { requiresScope: 'applications:write' });
    await send('PUT', '/staff/config/workflow', adminToken, { transitions: widened });

    // Counted rather than assumed to be the only one: audit_events is
    // append-only by trigger, so entries from earlier tests in this file are
    // still there and "exactly one row exists" would be a claim about test
    // order rather than about this write.
    const entries = await db.query<{ after_state: { controlsGivenUp: string[] } }>(
      `select after_state from audit_events where action = 'workflow.replaced'
        order by id desc limit 1`,
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]!.after_state.controlsGivenUp[0]).toMatch(/more officers can make it/);
  });
});

describe('the officers whose queues just changed', () => {
  it('tells every member of staff except the administrator who made the change', async () => {
    // D-5 made the routing rule editable and D-7 made the routing rule the
    // notification rule, so an edit here silently changes whose queue an
    // application lands in. An officer whose work simply stops arriving has no
    // way to discover why.
    const widened = withRule(await currentRules(), 'Document Verification', 'Rejected',
      { requiresScope: 'applications:write' });
    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: widened }))
      .statusCode).toBe(200);

    const notices = await db.query<{ account_id: string; title: string }>(
      `select account_id, title from staff_notifications where type = 'workflow-changed'`,
    );

    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]!.title).toBe('The application workflow changed');
    // The clerk, not the administrator: nobody is told about their own act.
    expect(notices.rows[0]!.account_id).toBe(archivistId);
    expect(notices.rows[0]!.account_id).not.toBe(adminAccountId);
  });

  it('tells nobody when the edit was refused', async () => {
    const stranding = (await currentRules()).filter((rule) => rule.from !== 'Received');

    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: stranding }))
      .statusCode).toBe(422);

    // Inside the transaction, so a refused edit cannot leave officers told
    // their workflow changed when it did not.
    const notices = await db.query(
      `select 1 from staff_notifications where type = 'workflow-changed'`,
    );
    expect(notices.rows).toHaveLength(0);
  });
});

describe('the order the moves are listed in', () => {
  it('is the order they were sent, not the order they were stored', async () => {
    // The portal draws a flow chart from this list, so the order is part of what
    // it serves. Nothing else records it: a set of rows has no order, and
    // re-reading them in whatever order the table returns would quietly turn a
    // process diagram into an index.
    const rules = await currentRules();
    const reversed = [...rules].reverse();

    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: reversed }))
      .statusCode).toBe(200);

    const served = await currentRules();
    expect(served.map((rule) => `${rule.from} -> ${rule.to}`))
      .toEqual(reversed.map((rule) => `${rule.from} -> ${rule.to}`));
    // And it really did change -- a test that reverses a palindrome proves
    // nothing.
    expect(served[0]).not.toEqual(rules[0]);
  });
});

describe('edits that would strand applications', () => {
  it('refuses a lifecycle where a status has no move out', async () => {
    const rules = (await currentRules())
      .filter((rule) => rule.from !== 'Received');

    const response = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: rules });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/Received/);
  });

  it('refuses a lifecycle that strands applications already in the queue', async () => {
    await file('Under Evaluation');
    // A WELL-FORMED graph: nothing enters 'Under Evaluation' either, so the
    // shape check above sees nothing wrong with it. Only the queue does.
    const rules = (await currentRules())
      .filter((rule) => rule.from !== 'Under Evaluation' && rule.to !== 'Under Evaluation');

    const response = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: rules });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/Under Evaluation/);
  });

  it('allows removing a move that leaves another way out', async () => {
    const rules = (await currentRules())
      .filter((rule) => !(rule.from === 'Received' && rule.to === 'Cancelled'));

    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: rules }))
      .statusCode).toBe(200);
  });
});

describe('what cannot be spelled at all', () => {
  it('refuses a status this system does not have', async () => {
    const rules = [...await currentRules(),
      { from: 'Received', to: 'Under Appeal', actors: ['staff'], requiresScope: 'applications:write',
        preconditions: [], notifies: null }];

    const response = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: rules });

    // Rejected by the schema, before the service sees it: the status list is
    // closed, and the moves between them are the editable part.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a move with no actor', async () => {
    const rules = withRule(await currentRules(), 'Submitted', 'Received', { actors: [] });

    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: rules }))
      .statusCode).toBe(400);
  });

  it('refuses a scope this system does not have', async () => {
    const rules = withRule(await currentRules(), 'Submitted', 'Received',
      { requiresScope: 'staff:super' });

    // A move requiring a scope no account can hold is an edge with a dead end
    // behind it -- the graph looks whole and the queue still stops.
    expect((await send('PUT', '/staff/config/workflow', adminToken, { transitions: rules }))
      .statusCode).toBe(400);
  });

  it('refuses a roles list that no longer follows from the scope', async () => {
    // The portal reads the workflow, changes the scope, and forgets to drop the
    // derived list. Silently ignoring it would leave an editor believing it had
    // granted a role.
    const rules = (await currentRules()).map((rule) =>
      (rule.from === 'Submitted' && rule.to === 'Received'
        ? { ...rule, requiresScope: 'staff:approve' } : rule));

    const response = await send('PUT', '/staff/config/workflow', adminToken,
      { transitions: rules });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/derived from requiresScope/);
  });
});
