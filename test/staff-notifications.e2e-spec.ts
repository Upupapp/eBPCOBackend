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
 * TAB 14 — the officer's worklist, over HTTP. Owner decision D-7.
 *
 * The assertion that carries the feature is that moving an application puts it
 * in the NEXT officer's inbox and nobody else's. A test that only reads back
 * what it inserted would pass against a server that notified everyone.
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

interface Inbox {
  notifications: {
    id: string; type: string; applicationId: string | null; routedToRole: string;
    title: string; body: string; deepLink: string | null; readAt: string | null;
  }[];
  unread: number;
}

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let applicantId: string;
let applicantAccount: string;
const staff = new Map<StaffRole, { id: string; token: string }>();
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

const send = (
  method: 'GET' | 'POST', url: string, token: string,
  payload?: Record<string, unknown>, headers: Record<string, string> = {},
) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });

const inboxOf = async (role: StaffRole): Promise<Inbox> => {
  const response = await send('GET', '/staff/notifications', staff.get(role)!.token);
  expect(response.statusCode).toBe(200);
  return response.json<Inbox>();
};

const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
  ['Assessed', 'Payment Submitted'], ['Payment Submitted', 'Payment Under Verification'],
];

async function file(target: LifecycleStatus): Promise<{ id: string; reference: string }> {
  const id = randomUUID();
  const reference = `EB-2026-${id.slice(0, 6)}`;
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,'Fencing','New','Submitted',now(),$4)`,
    [id, reference, applicantId, applicantAccount],
  );
  let current: LifecycleStatus = 'Submitted';
  while (current !== target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no route from ${current} to ${target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  return { id, reference };
}

/**
 * A paid order of payment, so an application can be BOUNCED between Payment
 * Submitted and Payment Under Verification. That round trip is the only
 * precondition-free way an application legitimately arrives in the same
 * officer's queue twice, which is what the unread-scoped dedup rule is about.
 */
async function payFor(applicationId: string): Promise<void> {
  const orderId = randomUUID();
  await db.query(
    `insert into orders_of_payment (id, application_id, number, filing_centavos,
       processing_centavos, architectural_centavos, structural_centavos,
       electrical_centavos, others_centavos, total_centavos, fee_schedule_version, assessed_by)
     values ($1,$2,$3,50000,120000,0,512000,0,0,682000,'2026.1',$4)`,
    [orderId, applicationId, `OP-${orderId.slice(0, 8)}`, staff.get('assessor')!.id],
  );
  await db.query(
    `insert into payments (order_of_payment_id, application_id, reference_number,
                           amount_centavos, method, submitted_by)
     values ($1,$2,$3,682000,'Bank Transfer',$4)`,
    [orderId, applicationId, `PAY-${orderId.slice(0, 8)}`, applicantAccount],
  );
}

const move = (applicationId: string, to: LifecycleStatus, role: StaffRole) =>
  send('POST', `/staff/applications/${applicationId}/transitions`,
    staff.get(role)!.token, { to }, { 'idempotency-key': randomUUID() });

/**
 * One database for the file. A fresh PGlite plus every migration per test
 * starves the other Jest workers -- measured on 2026-08-29, when a spec built
 * that way made an unrelated suite fail on hook timeouts and took 19 minutes.
 * What these tests dirty is undone in afterEach instead.
 */
beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  // `warn`, not `error`: the "nobody holds this role" signal is a warning, and
  // an error-level logger silently filters it -- which is how the first version
  // of that test passed a suite while asserting nothing.
  app = await createApp(loadConfig(ENV), new StructuredLogger('warn', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  staff.clear();
  for (const role of ['records-officer', 'receiving-officer', 'evaluator', 'assessor',
    'cashier', 'building-official', 'releasing-officer', 'administrator'] as StaffRole[]) {
    staff.set(role, await staffAccount(role));
  }

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
}, 60_000);

afterEach(async () => {
  await db.query('update accounts set disabled_at = null where kind = $1', ['staff']);
  // The inbox, and the applications that filled it. Archived rather than
  // deleted because notices and history reference them, and `archive_is_
  // attributable` requires an actor -- an archive entry with nobody
  // responsible for it is what that constraint exists to refuse.
  await db.query('delete from staff_notifications');
  await db.query(
    `update applications
        set archived_at = now(), archived_by = $1, archive_remarks = 'test fixture cleanup'
      where archived_at is null`,
    [staff.get('administrator')!.id],
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

describe('a move puts the application in the next officer’s inbox', () => {
  it('tells the receiving officer, and nobody else, when an application is filed', async () => {
    const { id, reference } = await file('Submitted');

    expect((await move(id, 'Received', 'records-officer')).statusCode).toBe(200);

    const intake = await inboxOf('receiving-officer');
    expect(intake.notifications).toHaveLength(1);
    expect(intake.notifications[0]!.title).toBe(`${reference} is waiting`);
    expect(intake.notifications[0]!.routedToRole).toBe('receiving-officer');
    expect(intake.unread).toBe(1);

    // The whole point of routing. Without it every one of these is 1.
    for (const role of ['evaluator', 'assessor', 'cashier', 'releasing-officer',
      'administrator'] as StaffRole[]) {
      expect((await inboxOf(role)).notifications).toHaveLength(0);
    }
  });

  it('does not tell the officer who made the move, even when the queue is theirs', async () => {
    const { id } = await file('Payment Under Verification');
    const second = await file('Payment Under Verification');

    // Sending a payment back for more proof lands it at Payment Submitted,
    // which routes BACK to the cashier -- so the officer who made the move is
    // the one the rule would otherwise notify. They know where it is; a notice
    // here is the noise that trains people to stop reading the inbox.
    expect((await move(id, 'Payment Submitted', 'cashier')).statusCode).toBe(200);
    expect((await inboxOf('cashier')).notifications).toHaveLength(0);

    // And the exclusion is about the ACTOR, not the role. A SECOND cashier
    // moving a different application must still reach the first -- otherwise
    // "don't tell the mover" would have quietly become "never tell a cashier",
    // and the inbox would be empty for the whole role.
    const colleague = await staffAccount('cashier');
    const moved = await send('POST', `/staff/applications/${second.id}/transitions`,
      colleague.token, { to: 'Payment Submitted' }, { 'idempotency-key': randomUUID() });
    expect(moved.statusCode).toBe(200);

    expect((await inboxOf('cashier')).notifications).toHaveLength(1);
    expect((await inboxOf('cashier')).notifications[0]!.applicationId).toBe(second.id);
  });

  it('tells nobody when the application is waiting on the applicant', async () => {
    const { id } = await file('Document Verification');

    // Revision Required is the applicant's move to make. The only staff move
    // out of it is Expire, and an officer told this is "waiting" would be
    // invited to expire an applicant who is doing what was asked.
    expect((await move(id, 'Revision Required', 'evaluator')).statusCode).toBe(200);

    for (const role of ['records-officer', 'receiving-officer', 'evaluator', 'assessor',
      'cashier', 'building-official', 'releasing-officer', 'administrator'] as StaffRole[]) {
      expect((await inboxOf(role)).notifications).toHaveLength(0);
    }
  });

  it('does not stack a second unread notice about the same application', async () => {
    const { id } = await file('Payment Under Verification');
    await payFor(id);
    const colleague = await staffAccount('cashier');
    const bounce = (to: LifecycleStatus) =>
      send('POST', `/staff/applications/${id}/transitions`, colleague.token, { to },
        { 'idempotency-key': randomUUID() });

    // The application really does arrive twice: sent back for more proof,
    // resubmitted, sent back again. The cashier is genuinely waiting each time.
    expect((await bounce('Payment Submitted')).statusCode).toBe(200);
    expect((await bounce('Payment Under Verification')).statusCode).toBe(200);
    expect((await bounce('Payment Submitted')).statusCode).toBe(200);

    // Two unread copies of "EB-123 is waiting" tell an officer nothing the
    // first did.
    expect((await inboxOf('cashier')).notifications).toHaveLength(1);
  });

  it('tells them again about an arrival they have already read about', async () => {
    const { id } = await file('Payment Under Verification');
    await payFor(id);
    const colleague = await staffAccount('cashier');
    const bounce = (to: LifecycleStatus) =>
      send('POST', `/staff/applications/${id}/transitions`, colleague.token, { to },
        { 'idempotency-key': randomUUID() });

    await bounce('Payment Submitted');
    const first = (await inboxOf('cashier')).notifications[0]!;
    await send('POST', `/staff/notifications/${first.id}/read`, staff.get('cashier')!.token);

    // The counterpart of the test above, and the reason the index is scoped to
    // unread rather than to all time. Suppressing this would mean an officer
    // who cleared their inbox never hears the application came back.
    await bounce('Payment Under Verification');
    await bounce('Payment Submitted');

    const inbox = await inboxOf('cashier');
    expect(inbox.notifications).toHaveLength(2);
    expect(inbox.unread).toBe(1);
  });

});

describe('when no officer holds the routed role', () => {
  it('says so, rather than filing the application into nobody’s queue', async () => {
    // An LGU that has not created a receiving officer, or whose only one is
    // disabled, gets applications arriving in a queue nobody is told about.
    // Nothing else would say so: the transition succeeds, the routing is
    // correct, and the inbox is simply empty.
    await db.query(
      'update accounts set disabled_at = now() where id = $1',
      [staff.get('receiving-officer')!.id],
    );
    const { id } = await file('Submitted');

    expect((await move(id, 'Received', 'records-officer')).statusCode).toBe(200);

    expect(logLines.join('\n')).toContain('no officer holds the role');
  });

  it('says nothing when the only holder is the officer who made the move', async () => {
    // Zero notices is CORRECT here and must not be reported as a gap -- not
    // telling an officer about their own act is deliberate. A warning on every
    // such move would train the operator to ignore the warning.
    const { id } = await file('Submitted');

    expect((await move(id, 'Received', 'receiving-officer')).statusCode).toBe(200);

    expect(logLines.some((line) => line.includes('no officer holds the role'))).toBe(false);
  });
});

describe('the inbox belongs to one officer', () => {
  it('refuses to mark another officer’s notice read, and says nothing about it', async () => {
    const { id } = await file('Submitted');
    await move(id, 'Received', 'records-officer');
    const notice = (await inboxOf('receiving-officer')).notifications[0]!;

    const response = await send('POST', `/staff/notifications/${notice.id}/read`,
      staff.get('cashier')!.token);

    // 404, not 403: answering "forbidden" would confirm the notice exists,
    // which is a fact about another officer's queue.
    expect(response.statusCode).toBe(404);
    expect((await inboxOf('receiving-officer')).notifications[0]!.readAt).toBeNull();
  });

  it('marks it read for the officer it belongs to, once', async () => {
    const { id } = await file('Submitted');
    await move(id, 'Received', 'records-officer');
    const notice = (await inboxOf('receiving-officer')).notifications[0]!;
    const token = staff.get('receiving-officer')!.token;

    expect((await send('POST', `/staff/notifications/${notice.id}/read`, token)).statusCode)
      .toBe(204);

    const after = await inboxOf('receiving-officer');
    expect(after.notifications[0]!.readAt).not.toBeNull();
    expect(after.unread).toBe(0);

    // Already read: nothing left to change, and reporting success would claim
    // this request did something.
    expect((await send('POST', `/staff/notifications/${notice.id}/read`, token)).statusCode)
      .toBe(404);
  });

  it('lets an administrator read their own inbox, holding no application scope', async () => {
    // The reason this route carries no scope requirement. `administrator` holds
    // only staff:administer, so requiring applications:read would send an
    // administrator notices they are then refused permission to read.
    expect((await inboxOf('administrator')).notifications).toEqual([]);
  });

  it('refuses an applicant outright', async () => {
    const issued = await tokens.issueAccessToken({
      sub: applicantAccount, sid: randomUUID(), kind: 'applicant',
      scopes: ['applications:read'],
    });
    const response = await send('GET', '/staff/notifications', issued.token);

    expect(response.statusCode).toBe(403);
  });
});

describe('what the notice says', () => {
  it('names the reference and not the applicant', async () => {
    const { id, reference } = await file('Submitted');
    await move(id, 'Received', 'records-officer');

    const notice = (await inboxOf('receiving-officer')).notifications[0]!;

    // A worklist is read at a counter, on a shared screen, all day. The
    // reference opens the record; the record is where access is checked.
    expect(`${notice.title} ${notice.body}`).toContain(reference);
    expect(`${notice.title} ${notice.body}`).not.toMatch(/Maria|Santos|example\.ph/);
    expect(notice.deepLink).toBe(`/staff/applications/${id}`);
  });
});
