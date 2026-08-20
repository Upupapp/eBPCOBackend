import { join } from 'node:path';

import { PgliteClient } from '../../persistence/pglite-client';
import { SqlClient } from '../../persistence/sql-client';
import { loadMigrations, migrate } from '../../persistence/migrator';
import { StructuredLogger } from '../logging/logger';
import { Job, JobRunner } from './job-runner';

/**
 * Running periodic work exactly once across a fleet.
 *
 * The property that matters is exclusion: two replicas ticking at the same
 * moment must not both run retention. Everything else here exists because the
 * failure modes are silent — a job that stopped working, a lock a dead replica
 * still holds, a failure message carrying a row from the query that failed.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../db/migrations');

let db: SqlClient;
let now: Date;
let lines: string[];

const logger = (): StructuredLogger => new StructuredLogger('info', (line) => lines.push(line));

const runner = (instance: string): JobRunner => new JobRunner(db, logger(), instance, () => now);

function job(overrides: Partial<Job> & { name: string }): Job {
  return {
    leaseSeconds: 60,
    run: () => Promise.resolve('done'),
    ...overrides,
  };
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  now = new Date('2026-08-20T04:00:00Z');
  lines = [];
});

afterEach(async () => {
  await db.close();
});

const jobRow = async (name: string) => (await db.query<{
  last_outcome: string | null; last_detail: string | null; consecutive_failures: number;
  locked_by: string | null; locked_until: Date | null; last_started_at: Date | null;
}>('select * from scheduled_jobs where name = $1', [name])).rows[0]!;

describe('exclusion', () => {
  it('lets exactly one replica run a job', async () => {
    // The whole reason this exists. Three replicas ticking at the same moment
    // must not all delete documents.
    const ran: string[] = [];
    const work = (instance: string) =>
      job({ name: 'document-retention', run: () => { ran.push(instance); return Promise.resolve('ok'); } });

    const outcomes = [];
    for (const instance of ['pod-a', 'pod-b', 'pod-c']) {
      outcomes.push(await runner(instance).runIfDue(work(instance)));
    }

    expect(ran).toHaveLength(1);
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
  });

  it('tells the others why they did not run', async () => {
    await runner('pod-a').runIfDue(job({ name: 'document-retention' }));

    const second = await runner('pod-b').runIfDue(job({ name: 'document-retention' }));

    expect(second.ran).toBe(false);
    if (second.ran) return;
    expect(second.reason).toBe('not-due');
  });

  it('does not run a job before its interval has elapsed', async () => {
    // notification-dispatch is on 60 seconds.
    await runner('pod-a').runIfDue(job({ name: 'notification-dispatch' }));
    now = new Date(now.getTime() + 30_000);

    const again = await runner('pod-a').runIfDue(job({ name: 'notification-dispatch' }));

    expect(again.ran).toBe(false);
  });

  it('runs it again once the interval has elapsed', async () => {
    await runner('pod-a').runIfDue(job({ name: 'notification-dispatch' }));
    now = new Date(now.getTime() + 61_000);

    expect((await runner('pod-a').runIfDue(job({ name: 'notification-dispatch' }))).ran).toBe(true);
  });

  it('skips a disabled job', async () => {
    // The off switch is an UPDATE, so a job can be stopped without a deploy.
    await db.query(`update scheduled_jobs set enabled = false where name = 'document-retention'`);

    const outcome = await runner('pod-a').runIfDue(job({ name: 'document-retention' }));

    expect(outcome.ran).toBe(false);
    if (outcome.ran) return;
    expect(outcome.reason).toBe('disabled');
  });

  it('refuses a job with no row, rather than inventing one', async () => {
    // A job row created at startup is a job that silently stops existing when
    // someone renames it in code, and the first anyone knows is that retention
    // has not run for a month.
    const outcome = await runner('pod-a').runIfDue(job({ name: 'a-job-nobody-declared' }));

    expect(outcome.ran).toBe(false);
    if (outcome.ran) return;
    expect(outcome.reason).toBe('unknown-job');
  });
});

describe('a replica that dies mid-job', () => {
  it('holds the job only until its lease expires', async () => {
    // Without expiry a SIGKILLed replica holds retention for ever and nobody
    // notices until a complaint.
    // Not awaited: the run never returns, which is the point — this is a
    // replica that was killed part-way through.
    void runner('pod-a').runIfDue(job({
      name: 'document-retention',
      leaseSeconds: 60,
      run: () => new Promise<string>(() => undefined),
    }));
    await Promise.resolve();
    // The claim is held; the run never finished, so nothing released it.
    expect((await jobRow('document-retention')).locked_by).toBe('pod-a');

    // Past both the lease and the interval.
    now = new Date(now.getTime() + 3_700_000);
    const second = await runner('pod-b').runIfDue(job({ name: 'document-retention' }));

    expect(second.ran).toBe(true);
  });

  it('does not let another replica in while the lease is live', async () => {
    void runner('pod-a').runIfDue(job({
      name: 'notification-dispatch',
      leaseSeconds: 600,
      run: () => new Promise<string>(() => undefined),
    }));
    await Promise.resolve();

    now = new Date(now.getTime() + 120_000); // past the interval, inside the lease
    const second = await runner('pod-b').runIfDue(job({ name: 'notification-dispatch' }));

    expect(second.ran).toBe(false);
    if (second.ran) return;
    expect(second.reason).toBe('held-elsewhere');
  });
});

describe('recording what happened', () => {
  it('records success and releases the claim', async () => {
    await runner('pod-a').runIfDue(job({
      name: 'document-retention', run: () => Promise.resolve('deleted 3, held back 0'),
    }));

    const row = await jobRow('document-retention');
    expect(row.last_outcome).toBe('succeeded');
    expect(row.last_detail).toBe('deleted 3, held back 0');
    expect(row.locked_by).toBeNull();
  });

  it('records a failure and releases the claim anyway', async () => {
    // A job that throws and keeps its lock is a job that never runs again.
    await runner('pod-a').runIfDue(job({
      name: 'document-retention', run: () => Promise.reject(new Error('object store unreachable')),
    }));

    const row = await jobRow('document-retention');
    expect(row.last_outcome).toBe('failed');
    expect(row.locked_by).toBeNull();
  });

  it('counts consecutive failures, because one is noise and nine is an outage', async () => {
    const failing = job({
      name: 'document-retention', run: () => Promise.reject(new Error('still broken')),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner('pod-a').runIfDue(failing);
      now = new Date(now.getTime() + 3_700_000);
    }

    expect(Number((await jobRow('document-retention')).consecutive_failures)).toBe(3);
  });

  it('resets the count on success', async () => {
    await runner('pod-a').runIfDue(job({
      name: 'document-retention', run: () => Promise.reject(new Error('broken')),
    }));
    now = new Date(now.getTime() + 3_700_000);
    await runner('pod-a').runIfDue(job({ name: 'document-retention' }));

    expect(Number((await jobRow('document-retention')).consecutive_failures)).toBe(0);
  });

  it('truncates a failure message rather than storing whatever the query touched', async () => {
    // A job failure can carry a row from the query that failed, and this table
    // is read by anyone with database access rather than under the audit
    // trail's rules.
    await runner('pod-a').runIfDue(job({
      name: 'document-retention', run: () => Promise.reject(new Error('x'.repeat(5000))),
    }));

    expect((await jobRow('document-retention')).last_detail!.length).toBeLessThanOrEqual(200);
  });

  it('logs a failure at error, because nobody is watching', async () => {
    await runner('pod-a').runIfDue(job({
      name: 'document-retention', run: () => Promise.reject(new Error('object store unreachable')),
    }));

    expect(lines.join('\n')).toContain('"level":"error"');
  });
});

describe('answering "did it run?"', () => {
  it('reports when each job last finished and whether it worked', async () => {
    // The question somebody asks at 9am after a complaint. An advisory lock
    // cannot answer it, which is half the reason this is a table.
    await runner('pod-a').runIfDue(job({ name: 'document-retention', run: () => Promise.resolve('deleted 0') }));

    const status = await runner('pod-a').status();
    const retention = status.find((entry) => entry.name === 'document-retention')!;

    expect(retention.lastOutcome).toBe('succeeded');
    expect(retention.lastFinishedAt).not.toBeNull();
    expect(status).toHaveLength(4);
  });

  it('does not report an expired claim as held', async () => {
    void runner('pod-a').runIfDue(job({
      name: 'document-retention', leaseSeconds: 60, run: () => new Promise<string>(() => undefined),
    }));
    await Promise.resolve();
    now = new Date(now.getTime() + 120_000);

    const held = (await runner('pod-b').status()).find((e) => e.name === 'document-retention')!.heldBy;

    expect(held).toBeNull();
  });
});
