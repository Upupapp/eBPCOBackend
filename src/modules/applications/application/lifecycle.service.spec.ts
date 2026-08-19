import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../domain/application';
import { LifecycleService } from './lifecycle.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

let db: SqlClient;
let service: LifecycleService;

const APPLICANT_ACCOUNT = randomUUID();
const OFFICER_ACCOUNT = randomUUID();
const APPLICANT = randomUUID();
const APPLICATION = randomUUID();

const applicant: Caller = { accountId: APPLICANT_ACCOUNT, kind: 'applicant', scopes: APPLICANT_SCOPES };
const officer: Caller = {
  accountId: OFFICER_ACCOUNT,
  kind: 'staff',
  scopes: [...new Set(Object.values(ROLE_SCOPES).flat())],
};

async function seed(): Promise<void> {
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1, 'applicant', 'maria@example.ph', 'maria@example.ph', 'scrypt$1$1$1$a$b'),
            ($2, 'staff', 'officer@lgu.gov.ph', 'officer@lgu.gov.ph', 'scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT, OFFICER_ACCOUNT],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1, $2, 'Maria', 'Santos')`,
    [APPLICANT, APPLICANT_ACCOUNT],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1, 'BP-2026-000001', $2, 'Fencing', 'New', 'Submitted', now(), $3)`,
    [APPLICATION, APPLICANT, APPLICANT_ACCOUNT],
  );
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  await seed();
  service = new LifecycleService(db, () => new Date('2026-08-19T12:00:00+08:00'));
});
afterEach(async () => {
  await db.close();
});

describe('reading a snapshot', () => {
  it('assembles every fact a decision depends on in one query', async () => {
    // One round trip rather than eight: eight separate reads can straddle
    // another officer's commit and produce a decision about a state that never
    // existed.
    const snapshot = await service.snapshot(APPLICATION);

    expect(snapshot).toMatchObject({
      id: APPLICATION,
      applicantAccountId: APPLICANT_ACCOUNT,
      status: 'Submitted',
      version: 1,
      openInstructionCount: 0,
      orderOfPaymentIssued: false,
      paymentVerified: false,
      permitGenerated: false,
    });
  });

  it('returns null for an unknown application', async () => {
    expect(await service.snapshot(randomUUID())).toBeNull();
  });

  it('returns null for a malformed id rather than throwing', async () => {
    expect(await service.snapshot('not-a-uuid')).toBeNull();
  });
});

describe('moving an application', () => {
  it('applies a legal move and advances the version', async () => {
    const result = await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect(result).toEqual({ ok: true, status: 'Received', version: 2 });
    const row = await db.query<{ lifecycle_status: string; version: number }>(
      'select lifecycle_status, version from applications where id = $1',
      [APPLICATION],
    );
    expect(row.rows[0]).toEqual({ lifecycle_status: 'Received', version: 2 });
  });

  it('refuses an illegal move and changes nothing', async () => {
    const result = await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Released' });

    expect(result.ok).toBe(false);
    const row = await db.query<{ lifecycle_status: string; version: number }>(
      'select lifecycle_status, version from applications where id = $1',
      [APPLICATION],
    );
    expect(row.rows[0]).toEqual({ lifecycle_status: 'Submitted', version: 1 });
  });

  it('refuses a move the caller may not make', async () => {
    const result = await service.transition({ applicationId: APPLICATION, caller: applicant, to: 'Received' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe('not-permitted');
  });

  it('suspends the RA 11032 clock on Revision Required, and restarts it on resubmission', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Revision Required' });

    const suspended = await db.query<{ pledge_suspended_since: Date | null }>(
      'select pledge_suspended_since from applications where id = $1',
      [APPLICATION],
    );
    expect(suspended.rows[0]?.pledge_suspended_since).not.toBeNull();

    await service.transition({ applicationId: APPLICATION, caller: applicant, to: 'Under Evaluation' });

    const resumed = await db.query<{ pledge_suspended_since: Date | null }>(
      'select pledge_suspended_since from applications where id = $1',
      [APPLICATION],
    );
    expect(resumed.rows[0]?.pledge_suspended_since).toBeNull();
  });
});

describe('what one move records', () => {
  // Acceptance criterion: exactly one audit event and the expected
  // notifications, with no duplicates on retry.

  const countAudit = async (): Promise<number> =>
    (await db.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'application.transitioned'",
    )).rows[0]?.count ?? 0;

  const notifications = async (): Promise<string[]> =>
    (await db.query<{ type: string }>('select type from notifications order by created_at')).rows.map((r) => r.type);

  it('writes exactly one audit event', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect(await countAudit()).toBe(1);
  });

  it('queues exactly the notification the rule names', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect(await notifications()).toEqual(['received-by-obo']);
  });

  it('writes the timeline row through the database trigger, not twice', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const trail = await db.query<{ to_status: string }>(
      'select to_status from application_transitions where application_id = $1 order by occurred_at',
      [APPLICATION],
    );
    expect(trail.rows.map((r) => r.to_status)).toEqual(['Submitted', 'Received']);
  });

  it('records NOTHING when the move is refused', async () => {
    // A refused move must not tell an applicant something happened.
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Released' });

    expect(await countAudit()).toBe(0);
    expect(await notifications()).toEqual([]);
  });

  it('does not duplicate on a retried refusal', async () => {
    for (let i = 0; i < 3; i += 1) {
      await service.transition({ applicationId: APPLICATION, caller: applicant, to: 'Received' });
    }

    expect(await countAudit()).toBe(0);
    expect(await notifications()).toEqual([]);
  });

  it('commits the status change and its notification together, or neither', async () => {
    // The whole reason both happen in one transaction: a notification sent for
    // a transition that then fails tells an applicant their permit is ready
    // when it is not.
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const status = await db.query<{ lifecycle_status: string }>(
      'select lifecycle_status from applications where id = $1',
      [APPLICATION],
    );
    expect(status.rows[0]?.lifecycle_status).toBe('Received');
    expect(await notifications()).toHaveLength(1);
    expect(await countAudit()).toBe(1);
  });

  it('carries evaluator remarks into the audit trail verbatim', async () => {
    const remarks = 'Sheet S-3 bears no signature — “resubmit”, per §304.\nBoundary 0.85m out.';
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });
    await service.transition({
      applicationId: APPLICATION, caller: officer, to: 'Revision Required', remarks,
    });

    const audit = await db.query<{ after_state: { remarks: string } }>(
      `select after_state from audit_events
        where action = 'application.transitioned' order by occurred_at desc limit 1`,
    );
    expect(audit.rows[0]?.after_state.remarks).toBe(remarks);
  });
});

describe('optimistic concurrency', () => {
  // Acceptance criterion 6, partially. What is verified here is the guard: two
  // callers deciding against the SAME version produce one winner and one
  // stale-version refusal, which is precisely the race. What is NOT verified is
  // wall-clock parallelism and the `for update` lock under real contention --
  // PGlite is a single connection, so that needs a real server and belongs to
  // TAB 16. Recorded rather than assumed.

  it('lets a caller who quotes the current version through', async () => {
    const result = await service.transition({
      applicationId: APPLICATION, caller: officer, to: 'Received', expectedVersion: 1,
    });

    expect(result.ok).toBe(true);
  });

  it('refuses a caller quoting a version that has moved on', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const late = await service.transition({
      applicationId: APPLICATION, caller: officer, to: 'Document Verification', expectedVersion: 1,
    });

    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.refusal.kind).toBe('stale-version');
  });

  it('produces exactly one winner when two callers act on the same version', async () => {
    // Both read version 1 and both decide "allowed". Only one may write.
    const both = await Promise.all([
      service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received', expectedVersion: 1 }),
      service.transition({ applicationId: APPLICATION, caller: officer, to: 'Cancelled', expectedVersion: 1 }),
    ]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toHaveLength(1);

    // And exactly one audit event, not two.
    const audits = await db.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'application.transitioned'",
    );
    expect(audits.rows[0]?.count).toBe(1);
  });
});
