import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES, StaffRole } from '../../identity/domain/account';
import { SqlCalendarRepository, EMPTY_CALENDAR } from '../../compliance/application/calendar.repository';
import { Caller } from '../domain/application';
import { LifecycleStatus } from '../domain/lifecycle';
import { StaffQueueService, visibleStatusesFor } from './staff-queue.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-19T04:00:00Z'); // noon in Manila

let db: SqlClient;
let queue: StaffQueueService;

const APPLICANT_ACCOUNT = randomUUID();
let applicantId: string;

function officer(role: StaffRole): Caller {
  return { accountId: randomUUID(), kind: 'staff', scopes: ROLE_SCOPES[role] };
}

async function file(options: {
  reference: string;
  status: LifecycleStatus;
  permitType?: string;
  submittedAt?: string;
  businessName?: string;
  charterEntryId?: string | null;
  classification?: 'Simple' | 'Complex' | 'Highly Technical' | null;
}): Promise<string> {
  const id = randomUUID();
  let businessId: string | null = null;
  if (options.businessName !== undefined) {
    businessId = randomUUID();
    await db.query(
      `insert into businesses (id, owner_applicant_id, name, category, street, barangay,
                               city, province, registration_number, date_registered, status)
       values ($1,$2,$3,'Retail','1 Main','Poblacion','Cabuyao','Laguna',$4,'2024-01-15','Active')`,
      [businessId, applicantId, options.businessName, `DTI-${options.reference}`],
    );
  }
  // Filed, then walked to the target along the transition table. The database
  // refuses an application created mid-lifecycle, and rightly: a row that
  // appeared at "Approved" never passed an evaluation. So the fixture obeys
  // the same rules production does.
  const startAt: LifecycleStatus = options.status === 'Draft' ? 'Draft' : 'Submitted';
  await db.query(
    `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                               application_action, lifecycle_status, submitted_at, charter_entry_id,
                               classification, created_by)
     values ($1,$2,$3,$4,$5,'New',$6,$7,$8,$9,$10)`,
    [
      id, options.reference, applicantId, businessId, options.permitType ?? 'Fencing',
      startAt,
      startAt === 'Draft' ? null : (options.submittedAt ?? NOW.toISOString()),
      options.charterEntryId ?? null,
      options.classification ?? null,
      APPLICANT_ACCOUNT,
    ],
  );

  for (const step of pathTo(options.status)) {
    await db.query('update applications set lifecycle_status = $1 where id = $2', [step, id]);
  }

  // The walk writes transition rows and touches updated_at; the fixture's
  // stated filing date is what the pledge must be measured from.
  if (options.submittedAt !== undefined) {
    await db.query('update applications set submitted_at = $1 where id = $2', [options.submittedAt, id]);
  }
  return id;
}

/**
 * The transition table, as an adjacency list, so a fixture can reach any status
 * by a legal route. Kept in the test rather than exported from the migration
 * because a test that reads its expectations from the thing under test proves
 * nothing.
 */
const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Draft', 'Submitted'], ['Draft', 'Cancelled'],
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
  ['Payment Under Verification', 'Payment Submitted'],
  ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['For Approval', 'Revision Required'], ['For Approval', 'Rejected'],
  ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
  ['Ready for Release', 'Released'], ['Released', 'Completed'],
];

/** Shortest legal route from Submitted to `target`, excluding the start. */
function pathTo(target: LifecycleStatus): readonly LifecycleStatus[] {
  if (target === 'Draft' || target === 'Submitted') return [];
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

async function loadCharter(pledgedWorkingDays: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into charter_entries (id, permit_type, classification, pledged_working_days,
                                  effective_from, fee_schedule_version, legal_basis)
     values ($1,'Fencing','Simple',$2,'2026-01-01','2026.1','Citizen''s Charter 2026')`,
    [id, pledgedWorkingDays],
  );
  return id;
}

const stubCalendar = { load: (): Promise<typeof EMPTY_CALENDAR> => Promise.resolve(EMPTY_CALENDAR) };

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  queue = new StaffQueueService(db, stubCalendar, () => NOW);

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
  await db.close();
});

describe('an officer sees only what their role needs', () => {
  it('refuses an applicant entirely, whatever scopes they hold', async () => {
    // Not a filter on their own applications: this is the staff surface, and
    // an applicant reaching it at all is a routing mistake, not a query.
    await file({ reference: 'BP-1', status: 'Submitted' });

    const page = await queue.page({
      accountId: APPLICANT_ACCOUNT, kind: 'applicant',
      scopes: ['applications:read', 'staff:administer'],
    });

    expect(page.rows).toHaveLength(0);
  });

  it('shows a cashier payment-stage applications and NOT freshly filed ones', async () => {
    // A cashier has no business reading the address and owner of an
    // application that has not reached assessment.
    await file({ reference: 'BP-1', status: 'Submitted' });
    await file({ reference: 'BP-2', status: 'Payment Submitted' });

    const page = await queue.page(officer('cashier'));

    expect(page.rows.map((r) => r.referenceNumber)).toEqual(['BP-2']);
  });

  it('shows a releasing officer nothing until a permit is approved', async () => {
    await file({ reference: 'BP-1', status: 'Under Evaluation' });
    await file({ reference: 'BP-2', status: 'Ready for Release' });

    const page = await queue.page(officer('releasing-officer'));

    expect(page.rows.map((r) => r.referenceNumber)).toEqual(['BP-2']);
  });

  it('shows a building official the whole pipeline', async () => {
    await file({ reference: 'BP-1', status: 'Submitted' });
    await file({ reference: 'BP-2', status: 'Ready for Release' });

    expect(visibleStatusesFor(officer('building-official'))).toBe('all');
    expect((await queue.page(officer('building-official'))).rows).toHaveLength(2);
  });

  it('returns nothing, rather than failing, for a role with no read scope', async () => {
    // An administrator role that only manages accounts is legitimate; an empty
    // queue is the correct answer, not an error.
    await file({ reference: 'BP-1', status: 'Submitted' });
    const noRead: Caller = { accountId: randomUUID(), kind: 'staff', scopes: [] };

    expect((await queue.page(noRead)).rows).toHaveLength(0);
    expect((await queue.metrics(noRead)).total).toBe(0);
  });

  it('never lets a requested filter widen what a role may see', async () => {
    // The obvious injection: ask for a status outside your visibility and get
    // it because the filter replaced the visibility clause instead of narrowing
    // within it.
    await file({ reference: 'BP-1', status: 'Submitted' });
    await file({ reference: 'BP-2', status: 'Payment Submitted' });

    const page = await queue.page(officer('cashier'), { statuses: ['Submitted'] });

    expect(page.rows).toHaveLength(0);
  });

  it('never shows a draft to anyone', async () => {
    // A draft is the applicant's private working copy. Nobody at the LGU has
    // filed anything yet, so nobody at the LGU may read it.
    await file({ reference: 'BP-1', status: 'Draft' });

    expect((await queue.page(officer('administrator'))).rows).toHaveLength(0);
    expect((await queue.metrics(officer('administrator'))).total).toBe(0);
  });
});

describe('search', () => {
  it('matches reference number, business name and applicant name', async () => {
    await file({ reference: 'BP-2026-000123', status: 'Submitted', businessName: 'Aling Nena Sari-Sari' });

    const admin = officer('administrator');
    expect((await queue.page(admin, { search: '000123' })).rows).toHaveLength(1);
    expect((await queue.page(admin, { search: 'Aling Nena' })).rows).toHaveLength(1);
    expect((await queue.page(admin, { search: 'Maria Santos' })).rows).toHaveLength(1);
    expect((await queue.page(admin, { search: 'nothing here' })).rows).toHaveLength(0);
  });

  it('treats a wildcard in the search term as a literal', async () => {
    // A business genuinely called "100% Fresh" must not match every row.
    await file({ reference: 'BP-1', status: 'Submitted', businessName: '100% Fresh Meats' });
    await file({ reference: 'BP-2', status: 'Submitted', businessName: 'Unrelated Hardware' });

    const page = await queue.page(officer('administrator'), { search: '100%' });

    expect(page.rows.map((r) => r.businessName)).toEqual(['100% Fresh Meats']);
  });
});

describe('paging a queue that is being worked', () => {
  it('shows no row twice, and no untouched row not at all, while the queue moves', async () => {
    // The property keyset paging actually gives, stated exactly. An OFFSET page
    // gives neither: a row moving to the front shifts every later row down, so
    // the second page repeats one and drops another.
    //
    // A row that MOVES is a different matter. It is now at the top of the
    // ordering, where the officer will meet it on the next pass, so not seeing
    // it again lower down is correct rather than a loss.
    const ids: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      ids.push(await file({ reference: `BP-${i}`, status: 'Submitted' }));
    }

    const admin = officer('administrator');
    const first = await queue.page(admin, { limit: 3 });
    expect(first.nextCursor).not.toBeNull();

    await db.query('update applications set updated_at = now() where id = $1', [ids[0]]);

    const second = await queue.page(admin, { limit: 3, cursor: first.nextCursor! });
    const seen = [...first.rows, ...second.rows].map((r) => r.referenceNumber);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(['BP-2', 'BP-3', 'BP-4', 'BP-5', 'BP-6']));
  });

  it('stops rather than looping on a cursor that is not one', async () => {
    await file({ reference: 'BP-1', status: 'Submitted' });

    const page = await queue.page(officer('administrator'), { cursor: 'not-a-cursor' });

    expect(page.rows).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('caps the page size a caller can ask for', async () => {
    for (let i = 1; i <= 5; i += 1) await file({ reference: `BP-${i}`, status: 'Submitted' });

    const page = await queue.page(officer('administrator'), { limit: 10_000 });

    expect(page.rows.length).toBeLessThanOrEqual(100);
  });
});

describe('the dashboard is counted by the database, not the browser', () => {
  it('counts every row, not just the first page', async () => {
    // The defect this replaces: the admin held all applications in memory and
    // filtered the array. A paginated client that counts what it received
    // reports the size of a page and calls it the size of the backlog.
    for (let i = 1; i <= 30; i += 1) await file({ reference: `BP-${i}`, status: 'Submitted' });

    const metrics = await queue.metrics(officer('administrator'));

    expect(metrics.total).toBe(30);
    expect(metrics.byStatus['Submitted']).toBe(30);
  });

  it('makes the total equal the sum of its visible breakdown', async () => {
    await file({ reference: 'BP-1', status: 'Submitted' });
    await file({ reference: 'BP-2', status: 'Under Evaluation' });
    await file({ reference: 'BP-3', status: 'Completed' });

    const metrics = await queue.metrics(officer('administrator'));
    const summed = Object.values(metrics.byStatus).reduce((a, b) => a + b, 0);

    expect(summed).toBe(metrics.total);
  });

  it('counts only what the caller may see', async () => {
    await file({ reference: 'BP-1', status: 'Submitted' });
    await file({ reference: 'BP-2', status: 'Payment Submitted' });

    expect((await queue.metrics(officer('cashier'))).total).toBe(1);
  });

  it('excludes Revision Required from the officer backlog', async () => {
    // The ball is with the applicant. Counting it as officer backlog makes the
    // LGU look slower than it is and hides the queue that is real.
    await file({ reference: 'BP-1', status: 'Revision Required' });
    await file({ reference: 'BP-2', status: 'Under Evaluation' });

    const metrics = await queue.metrics(officer('administrator'));

    expect(metrics.awaitingAction).toBe(1);
  });
});

describe('the pledge is the compliance module’s answer, not a second one', () => {
  it('is null where the charter has no entry, never a guessed deadline', async () => {
    await file({ reference: 'BP-1', status: 'Submitted' });

    expect((await queue.page(officer('administrator'))).rows[0]!.pledge).toBeNull();
  });

  it('counts working days, so a weekend is not a breach', async () => {
    // Filed Friday 14 August 2026 with a three-working-day pledge: due
    // Wednesday 19th. A calendar-day count would call this overdue on Monday.
    const charter = await loadCharter(3);
    await file({
      reference: 'BP-1', status: 'Under Evaluation', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-08-14T01:00:00Z',
    });

    const row = (await queue.page(officer('administrator'))).rows[0]!;

    expect(row.pledge).not.toBeNull();
    expect(row.pledge!.overdue).toBe(false);
    expect((await queue.metrics(officer('administrator'))).overduePledge).toBe(0);
  });

  it('honours the proclaimed calendar, so a holiday is not a working day', async () => {
    // 21 and 31 August 2026 are Ninoy Aquino Day and National Heroes Day. With
    // them proclaimed, a pledge that would otherwise expire moves out.
    await db.query(`insert into holiday_calendars (year, complete) values (2026, true)`);
    await db.query(
      `insert into holidays (year, holiday_date, name, kind)
       values (2026,'2026-08-21','Ninoy Aquino Day','Special Non-Working Day'),
              (2026,'2026-08-31','National Heroes Day','Regular Holiday')`,
    );
    const withCalendar = new StaffQueueService(
      db, new SqlCalendarRepository(db), () => new Date('2026-08-25T04:00:00Z'),
    );
    const charter = await loadCharter(5);
    await file({
      reference: 'BP-1', status: 'Under Evaluation', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-08-17T01:00:00Z',
    });

    const row = (await withCalendar.page(officer('administrator'))).rows[0]!;

    // Mon 17 filed; working days 18, 19, 20, (21 holiday), 24, 25 -> due 25.
    expect(row.pledge!.dueDate).toBe('2026-08-25');
    expect(row.pledge!.overdue).toBe(false);
  });

  it('excludes the applicant’s own time from the count', async () => {
    // RA 11032: the clock stops while the applicant is answering a deficiency.
    // Charging that time to the LGU reports a breach that did not happen.
    const charter = await loadCharter(3);
    const id = await file({
      reference: 'BP-1', status: 'Under Evaluation', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-08-10T01:00:00Z',
    });
    await db.query(
      `insert into application_transitions (application_id, from_status, to_status, actor_account_id, occurred_at)
       values ($1,'Under Evaluation','Revision Required',$2,'2026-08-11T01:00:00Z'),
              ($1,'Revision Required','Under Evaluation',$2,'2026-08-18T01:00:00Z')`,
      [id, APPLICANT_ACCOUNT],
    );

    const row = (await queue.page(officer('administrator'))).rows[0]!;

    expect(row.pledge!.workingDaysElapsed).toBeLessThan(3);
    expect(row.pledge!.overdue).toBe(false);
  });

  it('will not assert a breach on a year not yet fully proclaimed', async () => {
    // M-12. A movable Islamic holiday could still move the deadline, so this
    // is counted separately rather than reported as a missed statutory
    // deadline the calendar cannot support.
    const charter = await loadCharter(3);
    await file({
      reference: 'BP-1', status: 'Under Evaluation', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-08-03T01:00:00Z',
    });

    const metrics = await queue.metrics(officer('administrator'));

    expect(metrics.overduePledge).toBe(0);
    expect(metrics.pledgeIndeterminate).toBe(1);
  });

  it('asserts a breach once the calendar is fully proclaimed', async () => {
    await db.query(`insert into holiday_calendars (year, complete) values (2026, true)`);
    const withCalendar = new StaffQueueService(db, new SqlCalendarRepository(db), () => NOW);
    const charter = await loadCharter(3);
    await file({
      reference: 'BP-1', status: 'Under Evaluation', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-08-03T01:00:00Z',
    });

    const metrics = await withCalendar.metrics(officer('administrator'));

    expect(metrics.overduePledge).toBe(1);
    expect(metrics.pledgeIndeterminate).toBe(0);
  });

  it('stops the clock once the LGU has finished', async () => {
    // A released permit's compliance is a question for the compliance report,
    // which measures a period. It must not keep accruing overdue days here.
    const charter = await loadCharter(1);
    await file({
      reference: 'BP-1', status: 'Completed', charterEntryId: charter,
      classification: 'Simple', submittedAt: '2026-01-05T01:00:00Z',
    });

    expect((await queue.metrics(officer('administrator'))).overduePledge).toBe(0);
  });
});
