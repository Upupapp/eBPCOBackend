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
 * TAB 05 — preparing an assessment, and having a second officer approve it.
 *
 * Issuing an Order of Payment used to be one act by one officer: read the
 * schedule, compute six figures, write a bill an applicant must pay. The
 * assertions that carry weight here are the ones about the SECOND signature.
 */

jest.setTimeout(30_000);

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
let preparer: { id: string; token: string };
let reviewer: { id: string; token: string };
let applicationId: string;
const logLines: string[] = [];

async function staff(role: StaffRole): Promise<{ id: string; token: string }> {
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
  method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>,
) => app.inject({
  method, url,
  headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
  ...(payload === undefined ? {} : { payload }),
});

const draft = () => send('POST', `/staff/applications/${applicationId}/assessments`, preparer.token, {});

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  preparer = await staff('assessor');
  reviewer = await staff('assessor');

  const account = randomUUID();
  const applicant = randomUUID();
  applicationId = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [account],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicant, account],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'E-BPCO-2026-000501',$2,'Fencing','New','Submitted', now(), $3)`,
    [applicationId, applicant, account],
  );
  // Walked to where an assessor can see it. Scope visibility narrows the queue
  // by status, so an application still at Submitted is invisible to the officer
  // whose job starts after evaluation — and the order-of-payment route reads it
  // through that same filter, answering "no such application" rather than
  // leaking that one exists.
  for (const status of ['Received', 'Document Verification', 'Under Evaluation']) {
    await db.query('update applications set lifecycle_status = $1 where id = $2', [status, applicationId]);
  }

  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  for (const [line, amount] of [['filing', 50_000], ['processing', 120_000], ['structural', 512_000]] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1','Fencing',$1,$2,'City Ordinance 2026-004 s.3')`,
      [line, amount],
    );
  }
});

afterEach(async () => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  await app.close();
  await db.close();
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

describe('opening a draft', () => {
  it('pre-fills the six lines from the schedule in force', async () => {
    const response = await draft();

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      status: string; feeScheduleVersion: string; totalCentavos: number;
      lines: { line: string; computedCentavos: number; amountCentavos: number }[];
    }>();
    expect(body.status).toBe('Draft');
    expect(body.feeScheduleVersion).toBe('2026.1');
    // All six, in the canonical order an applicant reads them, never five.
    expect(body.lines.map((l) => l.line)).toEqual([
      'filing', 'processing', 'architectural', 'structural', 'electrical', 'others',
    ]);
    expect(body.totalCentavos).toBe(682_000);
    // What the schedule said sits beside what the officer set, and they start equal.
    expect(body.lines.every((l) => l.computedCentavos === l.amountCentavos)).toBe(true);
  });

  it('refuses a second open draft for the same application', async () => {
    // Two officers drafting different figures for one permit is how an
    // applicant is handed two bills.
    await draft();

    const second = await draft();

    expect(second.statusCode).toBe(422);
    expect(second.json<{ detail: string }>().detail).toMatch(/already Draft/i);
  });

  it('refuses when no fee schedule is in force', async () => {
    await db.query('delete from fee_schedule_entries');
    await db.query('delete from fee_schedules');

    const response = await draft();

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/schedule/i);
  });
});

describe('adjusting the lines', () => {
  const open = async (): Promise<string> => (await draft()).json<{ id: string }>().id;

  it('records an override as an override, not just as the new figure', async () => {
    // "The officer charged less than the ordinance prescribes" is a question an
    // auditor will ask, and it cannot be answered from the final figure.
    const id = await open();

    const response = await send('PUT', `/staff/assessments/${id}/lines/structural`, preparer.token, {
      amountCentavos: 256_000, basis: 'Reduced under City Ordinance 2026-004 s.7(b).',
    });

    expect(response.statusCode).toBe(200);
    const line = response.json<{ lines: { line: string; computedCentavos: number; amountCentavos: number }[] }>()
      .lines.find((l) => l.line === 'structural');
    expect(line).toMatchObject({ computedCentavos: 512_000, amountCentavos: 256_000 });

    const audit = await db.query<{ after_state: { overridesSchedule: boolean } }>(
      `select after_state from audit_events where action = 'assessment.line-changed'
        order by sequence desc limit 1`,
    );
    expect(audit.rows[0]?.after_state.overridesSchedule).toBe(true);
  });

  it('excludes a line and takes it out of the total', async () => {
    const id = await open();

    const response = await send('PUT', `/staff/assessments/${id}/lines/processing`, preparer.token, {
      included: false,
    });

    expect(response.json<{ totalCentavos: number }>().totalCentavos).toBe(562_000);
  });

  it('REFUSES a charge that names no authority', async () => {
    // RA 11032's transparency requirement is not satisfied by a total. This is
    // the rule the issue path already enforced, moved to where the officer can
    // still do something about it.
    const id = await open();

    const response = await send('PUT', `/staff/assessments/${id}/lines/others`, preparer.token, {
      amountCentavos: 90_000,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/ordinance or issuance/i);
  });

  it('refuses a fee line that does not exist', async () => {
    const id = await open();

    const response = await send('PUT', `/staff/assessments/${id}/lines/bribes`, preparer.token, {
      amountCentavos: 1,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses an edit once it has been submitted', async () => {
    const id = await open();
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);

    const response = await send('PUT', `/staff/assessments/${id}/lines/filing`, preparer.token, {
      amountCentavos: 1,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/only a draft/i);
  });
});

describe('the second signature', () => {
  const submitted = async (): Promise<string> => {
    const id = (await draft()).json<{ id: string }>().id;
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    return id;
  };

  it('REFUSES THE OFFICER WHO PREPARED IT', async () => {
    // The point of the whole workflow.
    const id = await submitted();

    const response = await send('POST', `/staff/assessments/${id}/approve`, preparer.token);

    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toMatch(/prepared or submitted/i);
    const row = await db.query<{ status: string }>('select status from assessments where id = $1', [id]);
    expect(row.rows[0]?.status).toBe('Submitted');
  });

  it('allows a different officer, which proves the refusal is about the person', async () => {
    const id = await submitted();

    const response = await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; approvedBy: string }>()).toMatchObject({
      status: 'Approved', approvedBy: reviewer.id,
    });
  });

  it('is refused by the database too, not only by the service', async () => {
    // A bug that has to defeat a constraint is much harder to write than one
    // that has to defeat an `if`.
    const id = await submitted();

    await expect(db.query(
      'update assessments set approved_by = $1, approved_at = now() where id = $2',
      [preparer.id, id],
    )).rejects.toThrow(/approver_is_not_the_assessor/);
  });

  it('refuses to approve something that was never submitted', async () => {
    const id = (await draft()).json<{ id: string }>().id;

    const response = await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/only a submitted/i);
  });

  it('refuses to submit an assessment that charges nothing', async () => {
    const id = (await draft()).json<{ id: string }>().id;
    for (const line of ['filing', 'processing', 'structural']) {
      await send('PUT', `/staff/assessments/${id}/lines/${line}`, preparer.token, { included: false });
    }

    const response = await send('POST', `/staff/assessments/${id}/submit`, preparer.token);

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/nothing to approve/i);
  });
});

describe('issuing the Order of Payment', () => {
  it('REFUSES to issue without an approved assessment', async () => {
    // The acceptance criterion, and the reason the workflow exists.
    const response = await send(
      'POST', `/staff/applications/${applicationId}/order-of-payment`, preparer.token, {},
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/no approved assessment/i);
  });

  it('issues from the approved figures, not from a fresh read of the schedule', async () => {
    // Re-computing here would let the Order differ from what a second officer
    // actually approved — which is the only figure anyone agreed to.
    const id = (await draft()).json<{ id: string }>().id;
    await send('PUT', `/staff/assessments/${id}/lines/structural`, preparer.token, {
      amountCentavos: 256_000, basis: 'Reduced under City Ordinance 2026-004 s.7(b).',
    });
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);

    const response = await send(
      'POST', `/staff/applications/${applicationId}/order-of-payment`, preparer.token, {},
    );

    expect(response.statusCode).toBe(201);
    const order = await db.query<{ structural_centavos: string; total_centavos: string; assessment_id: string }>(
      'select structural_centavos, total_centavos, assessment_id from orders_of_payment where application_id = $1',
      [applicationId],
    );
    expect(Number(order.rows[0]?.structural_centavos)).toBe(256_000);
    expect(Number(order.rows[0]?.total_centavos)).toBe(426_000);
    // And it names the assessment it came from, so the approval is traceable
    // from the instrument the applicant holds.
    expect(order.rows[0]?.assessment_id).toBe(id);
  });

  it('carries an excluded line onto the Order as an explicit zero', async () => {
    // Never a missing line: an applicant sees that processing fees were
    // considered and were nil, rather than wondering whether they were forgotten.
    const id = (await draft()).json<{ id: string }>().id;
    await send('PUT', `/staff/assessments/${id}/lines/processing`, preparer.token, { included: false });
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);
    await send('POST', `/staff/applications/${applicationId}/order-of-payment`, preparer.token, {});

    const order = await db.query<{ processing_centavos: string }>(
      'select processing_centavos from orders_of_payment where application_id = $1', [applicationId],
    );
    expect(Number(order.rows[0]?.processing_centavos)).toBe(0);
  });
});

describe('correcting an Order that is already in force', () => {
  const issued = async (): Promise<string> => {
    const id = (await draft()).json<{ id: string }>().id;
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);
    const order = await send(
      'POST', `/staff/applications/${applicationId}/order-of-payment`, preparer.token, {},
    );
    expect(order.statusCode).toBe(201);
    return order.json<{ orderId: string }>().orderId;
  };

  const revision = async (structural: number): Promise<void> => {
    const response = await send(
      'POST', `/staff/applications/${applicationId}/assessments`, preparer.token, { revision: true },
    );
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    await send('PUT', `/staff/assessments/${id}/lines/structural`, preparer.token, {
      amountCentavos: structural, basis: 'Recomputed after the revised plan reduced the floor area.',
    });
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);
  };

  it('REFUSES to supersede without an approved revision', async () => {
    // The hole routing this would otherwise have opened: `supersede` took its
    // figures straight from the caller, so one officer could have replaced an
    // approved bill with any amount they liked.
    const orderId = await issued();

    const response = await send('POST', `/staff/orders-of-payment/${orderId}/supersede`, preparer.token, {
      reason: 'The structural fee was computed from the wrong floor area.',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/no approved revision/i);
  });

  it('replaces it from the approved revision, leaving exactly one in force', async () => {
    const orderId = await issued();
    await revision(100_000);

    const response = await send('POST', `/staff/orders-of-payment/${orderId}/supersede`, preparer.token, {
      reason: 'The structural fee was computed from the wrong floor area.',
    });

    expect(response.statusCode).toBe(201);
    const orders = await db.query<{ total_centavos: string; superseded_at: Date | null; supersedes_id: string | null }>(
      'select total_centavos, superseded_at, supersedes_id from orders_of_payment order by assessed_at',
    );
    expect(orders.rows).toHaveLength(2);
    expect(orders.rows[0]?.superseded_at).not.toBeNull();
    expect(orders.rows[1]?.superseded_at).toBeNull();
    expect(orders.rows[1]?.supersedes_id).toBe(orderId);
    expect(Number(orders.rows[1]?.total_centavos)).toBe(270_000);
  });

  it('requires a reason the applicant can read', async () => {
    const orderId = await issued();
    await revision(100_000);

    const response = await send('POST', `/staff/orders-of-payment/${orderId}/supersede`, preparer.token, {
      reason: 'fix',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a revision when nothing is in force to revise', async () => {
    // A revision that silently became a first assessment would skip the reason
    // an applicant is owed for a bill that changed.
    const response = await send(
      'POST', `/staff/applications/${applicationId}/assessments`, preparer.token, { revision: true },
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/nothing to revise/i);
  });

  it('still refuses an ordinary draft while an Order is in force', async () => {
    await issued();

    const response = await draft();

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/already in force/i);
  });
});

describe('the audit trail', () => {
  it('records every step with the officer who took it', async () => {
    const id = (await draft()).json<{ id: string }>().id;
    await send('PUT', `/staff/assessments/${id}/lines/filing`, preparer.token, {
      amountCentavos: 60_000, basis: 'City Ordinance 2026-004 s.3',
    });
    await send('POST', `/staff/assessments/${id}/submit`, preparer.token);
    await send('POST', `/staff/assessments/${id}/approve`, reviewer.token);

    const audit = await db.query<{ action: string; actor_account_id: string }>(
      `select action, actor_account_id from audit_events
        where subject_id = $1 order by sequence`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'assessment.drafted', 'assessment.line-changed', 'assessment.submitted', 'assessment.approved',
    ]);
    expect(audit.rows[3]?.actor_account_id).toBe(reviewer.id);
    expect(audit.rows[0]?.actor_account_id).toBe(preparer.id);
  });

  it('records nothing for a line change that changes nothing', async () => {
    const id = (await draft()).json<{ id: string }>().id;

    await send('PUT', `/staff/assessments/${id}/lines/filing`, preparer.token, { amountCentavos: 50_000 });

    const audit = await db.query<{ n: string }>(
      `select count(*) as n from audit_events where action = 'assessment.line-changed'`,
    );
    expect(Number(audit.rows[0]?.n)).toBe(0);
  });
});
