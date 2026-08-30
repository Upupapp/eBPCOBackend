import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { HolidayCalendar } from '../domain/pledge-clock';
import { complianceReport } from './compliance-report';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

const complete: HolidayCalendar = {
  completeYears: new Set([2026]),
  holidays: new Set(['2026-08-21', '2026-08-31']),
};
const incomplete: HolidayCalendar = { ...complete, completeYears: new Set() };

let db: SqlClient;
const APPLICANT_ACCOUNT = randomUUID();
let applicantId: string;

async function charter(permitType: string, classification: string, days: number): Promise<void> {
  await db.query(
    `insert into charter_entries (permit_type, classification, pledged_working_days,
                                  effective_from, fee_schedule_version)
     values ($1, $2, $3, '2026-01-01', '2026.1')`,
    [permitType, classification, days],
  );
}

/** Files an application and walks it to completion on the given date. */
async function application(options: {
  permitType: string; submittedAt: string; completedAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by, classification)
     values ($1,$2,$3,$4,'New','Submitted',$5,$6,
             (select classification from charter_entries where permit_type = $4 limit 1))`,
    [id, `BP-${id.slice(0, 8)}`, applicantId, options.permitType, options.submittedAt, APPLICANT_ACCOUNT],
  );
  if (options.completedAt !== undefined) {
    // Recorded directly on the timeline: this test is about the report's
    // arithmetic, not about walking every legal transition.
    await db.query(
      `insert into application_transitions (application_id, from_status, to_status, occurred_at)
       values ($1, 'Ready for Release', 'Released', $2)`,
      [id, options.completedAt],
    );
  }
  return id;
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
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

const window = { from: '2026-08-01', to: '2026-09-01' };
const run = (calendar = complete, now = new Date('2026-09-15T02:00:00Z')) =>
  complianceReport(db, { ...window, calendar, now });

describe('what the report counts', () => {
  it('counts an application finished inside its pledge as compliant', async () => {
    await charter('Fencing', 'Simple', 3);
    // Filed Wed 19th, released Tue 25th: the third working day, since Friday
    // the 21st is a holiday.
    await application({ permitType: 'Fencing', submittedAt: '2026-08-19T02:00:00Z', completedAt: '2026-08-25T02:00:00Z' });

    const report = await run();

    expect(report.totalMeasured).toBe(1);
    expect(report.rows[0]).toMatchObject({ permitType: 'Fencing', withinPledge: 1, beyondPledge: 0 });
    expect(report.overallComplianceRate).toBe(1);
  });

  it('counts one finished beyond its pledge as non-compliant', async () => {
    await charter('Fencing', 'Simple', 3);
    await application({ permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-19T02:00:00Z' });

    const report = await run();

    expect(report.rows[0]).toMatchObject({ withinPledge: 0, beyondPledge: 1 });
    expect(report.overallComplianceRate).toBe(0);
  });

  it('reconciles against a hand-computed mix', async () => {
    // Acceptance criterion. Three within, one beyond, expected rate 0.75.
    await charter('Fencing', 'Simple', 3);
    for (const [submitted, completed] of [
      ['2026-08-03T02:00:00Z', '2026-08-06T02:00:00Z'],
      ['2026-08-04T02:00:00Z', '2026-08-07T02:00:00Z'],
      ['2026-08-05T02:00:00Z', '2026-08-10T02:00:00Z'],
      ['2026-08-06T02:00:00Z', '2026-08-20T02:00:00Z'],
    ] as const) {
      await application({ permitType: 'Fencing', submittedAt: submitted, completedAt: completed });
    }

    const report = await run();

    expect(report.rows[0]?.total).toBe(4);
    expect(report.rows[0]?.withinPledge).toBe(3);
    expect(report.rows[0]?.beyondPledge).toBe(1);
    expect(report.overallComplianceRate).toBe(0.75);
  });

  it('groups by permit type and classification', async () => {
    await charter('Fencing', 'Simple', 3);
    await charter('New Construction', 'Complex', 7);
    await application({ permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-06T02:00:00Z' });
    await application({ permitType: 'New Construction', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-12T02:00:00Z' });

    const report = await run();

    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((row) => row.classification).sort()).toEqual(['Complex', 'Simple']);
  });
});

describe('what the report refuses to count', () => {
  it('does not count an unclassified application at all', async () => {
    // No charter entry means no promise, and a promise nobody made cannot be
    // broken. This is M-08 showing through: with the schedule unloaded, every
    // application lands here.
    await application({ permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-30T02:00:00Z' });

    const report = await run();

    expect(report.unclassified).toBe(1);
    expect(report.totalMeasured).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it('does not put an LGU in the missed column on an approximate date', async () => {
    // The worst error this report could make. A proclamation issued later can
    // add working days, and a date that could still move is not evidence.
    await charter('Fencing', 'Simple', 3);
    await application({ permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-25T02:00:00Z' });

    const report = await run(incomplete);

    expect(report.rows[0]?.indeterminate).toBe(1);
    expect(report.rows[0]?.beyondPledge).toBe(0);
    expect(report.rows[0]?.withinPledge).toBe(0);
  });

  it('reports a null rate rather than 100% when nothing is measurable', async () => {
    // A rate computed over zero applications reads as perfect compliance.
    await charter('Fencing', 'Simple', 3);
    await application({ permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-25T02:00:00Z' });

    const report = await run(incomplete);

    expect(report.rows[0]?.complianceRate).toBeNull();
    expect(report.overallComplianceRate).toBeNull();
  });

  it('counts nothing outside the reporting window', async () => {
    await charter('Fencing', 'Simple', 3);
    await application({ permitType: 'Fencing', submittedAt: '2026-06-03T02:00:00Z', completedAt: '2026-06-06T02:00:00Z' });

    expect((await run()).totalMeasured).toBe(0);
  });
});

describe('the applicant’s own delay is not the LGU’s', () => {
  it('excludes time the applicant held a deficiency', async () => {
    // RA 11032 excludes it, and counting it would attribute the applicant's
    // delay to the LGU.
    await charter('Fencing', 'Simple', 3);
    const id = await application({
      permitType: 'Fencing', submittedAt: '2026-08-03T02:00:00Z', completedAt: '2026-08-28T02:00:00Z',
    });
    await db.query(
      `insert into application_transitions (application_id, from_status, to_status, occurred_at)
       values ($1, 'Under Evaluation', 'Revision Required', '2026-08-05T02:00:00Z'),
              ($1, 'Revision Required', 'Under Evaluation', '2026-08-26T02:00:00Z')`,
      [id],
    );

    const report = await run();

    expect(report.rows[0]?.withinPledge).toBe(1);
    expect(report.rows[0]?.beyondPledge).toBe(0);
  });
});
