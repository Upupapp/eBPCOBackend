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
const DRAFT_APPLICATION = randomUUID();

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
  // The access assignment migration 032 backfills for every real officer. The
  // allow-list fails CLOSED, so without it every staff transition below is
  // refused `forms:<permit type>` — correct, and not what these tests are about.
  await db.query(
    'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [OFFICER_ACCOUNT, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [OFFICER_ACCOUNT]);
  // Every evaluation stage too (migration 057): this fixture stands for a fully
  // assigned officer, the one these tests were written against.
  await db.query(
    `insert into staff_evaluation_stages (account_id, stage, granted_by)
     select $1, stage, $1 from unnest(array['Initial','Zoning','Fire Safety','OBO','Final Approval']) as stage`, [OFFICER_ACCOUNT]);
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1, 'BP-2026-000001', $2, 'Fencing Permit', 'New', 'Submitted', now(), $3)`,
    [APPLICATION, APPLICANT, APPLICANT_ACCOUNT],
  );
  // A self-service Draft: not yet filed, submitted_at null (the CHECK
  // constraint that requires it non-null applies only once the status
  // leaves 'Draft'), created by the applicant themselves.
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1, 'BP-2026-000002', $2, 'Fencing Permit', 'New', 'Draft', null, $3)`,
    [DRAFT_APPLICATION, APPLICANT, APPLICANT_ACCOUNT],
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
    if (result.ok || 'reused' in result) return;
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

    // Ordered by `sequence`, not `occurred_at`: the clock is pinned in these
    // tests, so every event shares a timestamp and ordering by it is
    // non-deterministic. That is precisely why TAB 09 gave the audit trail a
    // sequence — two events in the same millisecond still have a defined order.
    const audit = await db.query<{ after_state: { remarks: string } }>(
      `select after_state from audit_events
        where action = 'application.transitioned' order by sequence desc limit 1`,
    );
    expect(audit.rows[0]?.after_state.remarks).toBe(remarks);
  });

  it('carries evaluator remarks into application_transitions, not just the audit trail', async () => {
    // The audit trail is not the only reader: staff-queue.service.ts and
    // applicant-query.service.ts both render `application_transitions.remarks`
    // directly as the applicant/staff-facing timeline text. The trigger that
    // writes that table had no way to see the remarks at all until this was
    // wired through set_config()/current_setting() — this is what a caller
    // of THAT table, not the audit trail, actually sees.
    const remarks = 'Lot plan not signed by a geodetic engineer.';
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });
    await service.transition({
      applicationId: APPLICATION, caller: officer, to: 'Revision Required', remarks,
    });

    const row = await db.query<{ remarks: string | null }>(
      `select remarks from application_transitions
        where application_id = $1 and to_status = 'Revision Required'`,
      [APPLICATION],
    );
    expect(row.rows[0]?.remarks).toBe(remarks);
  });

  it('leaves application_transitions.remarks null when no remarks were given', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const row = await db.query<{ remarks: string | null }>(
      `select remarks from application_transitions
        where application_id = $1 and to_status = 'Received'`,
      [APPLICATION],
    );
    expect(row.rows[0]?.remarks).toBeNull();
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
    if (late.ok || 'reused' in late) return;
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

describe('follow-on moves', () => {
  // Submitted -> Received -> Document Verification are all staff moves with
  // no preconditions, which makes them the plainest chain to exercise.
  it('makes every hop in order and reports where the application stands', async () => {
    const chain = await service.followOn({
      applicationId: APPLICATION,
      hops: [{ caller: officer, to: 'Received' }, { caller: officer, to: 'Document Verification' }],
    });

    expect(chain).toEqual({ status: 'Document Verification', stoppedAt: null });
    const row = await db.query<{ lifecycle_status: string }>(
      'select lifecycle_status from applications where id = $1', [APPLICATION]);
    expect(row.rows[0]?.lifecycle_status).toBe('Document Verification');
  });

  it('resumes after a hop an officer already made by hand, rather than refusing to repeat it', async () => {
    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const chain = await service.followOn({
      applicationId: APPLICATION,
      hops: [{ caller: officer, to: 'Received' }, { caller: officer, to: 'Document Verification' }],
    });

    expect(chain).toEqual({ status: 'Document Verification', stoppedAt: null });
    // One transition row per move actually made — the repeated one was skipped, not re-recorded.
    const moves = await db.query<{ count: number }>(
      'select count(*)::int as count from application_transitions where application_id = $1 and from_status is not null',
      [APPLICATION]);
    expect(moves.rows[0]?.count).toBe(2);
  });

  it('stops at the first refused hop, keeps what landed, and names the refusal', async () => {
    // Document Verification -> Under Evaluation needs a verified identity
    // document and every required document present; this application has
    // neither, so the third hop is refused on its preconditions.
    const chain = await service.followOn({
      applicationId: APPLICATION,
      hops: [
        { caller: officer, to: 'Received' },
        { caller: officer, to: 'Document Verification' },
        { caller: officer, to: 'Under Evaluation' },
      ],
    });

    expect(chain.status).toBe('Document Verification');
    expect(chain.stoppedAt?.to).toBe('Under Evaluation');
    expect(chain.stoppedAt?.refusal.kind).toBe('precondition-unmet');
  });

  it('answers null for an application that does not exist, without throwing', async () => {
    const chain = await service.followOn({
      applicationId: randomUUID(), hops: [{ caller: officer, to: 'Received' }],
    });
    expect(chain).toEqual({ status: null, stoppedAt: null });
  });
});

describe('leaving Draft', () => {
  // The shared UPDATE in transition() never touched submitted_at until this
  // was found by reading submitted_at_matches_status (migration 003)
  // against it -- so every Draft->X move, including the one this whole
  // describe block exercises, would have failed the CHECK constraint
  // outright before the fix.

  async function markIdentityVerified(applicationId: string): Promise<void> {
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared)
       values ($1,$2,$3,'Valid ID','id.jpg','image/jpeg',1024,$4,$5,'Approved',true)`,
      [randomUUID(), applicationId, APPLICANT_ACCOUNT, 'a'.repeat(64), `objects/${randomUUID()}.jpg`],
    );
  }

  it('refuses Submitted while the identity document is unverified, and touches nothing', async () => {
    const result = await service.transition({
      applicationId: DRAFT_APPLICATION, caller: applicant, to: 'Submitted',
    });

    expect(result.ok).toBe(false);
    if (result.ok || 'reused' in result) return;
    expect(result.refusal.kind).toBe('precondition-unmet');
    const row = await db.query<{ lifecycle_status: string; submitted_at: Date | null }>(
      'select lifecycle_status, submitted_at from applications where id = $1', [DRAFT_APPLICATION]);
    expect(row.rows[0]).toEqual({ lifecycle_status: 'Draft', submitted_at: null });
  });

  it('moves Draft to Submitted and stamps submitted_at, once its preconditions are met', async () => {
    await markIdentityVerified(DRAFT_APPLICATION);

    const result = await service.transition({
      applicationId: DRAFT_APPLICATION, caller: applicant, to: 'Submitted',
    });

    expect(result).toEqual({ ok: true, status: 'Submitted', version: 2 });
    const row = await db.query<{ lifecycle_status: string; submitted_at: Date | null }>(
      'select lifecycle_status, submitted_at from applications where id = $1', [DRAFT_APPLICATION]);
    expect(row.rows[0]?.lifecycle_status).toBe('Submitted');
    expect(row.rows[0]?.submitted_at).not.toBeNull();
  });

  it('moves Draft to Cancelled with no precondition at all, and still stamps submitted_at', async () => {
    // Cancelled carries no preconditions, but the CHECK constraint applies
    // regardless of which status a Draft is leaving TO.
    const result = await service.transition({
      applicationId: DRAFT_APPLICATION, caller: applicant, to: 'Cancelled',
    });

    expect(result).toEqual({ ok: true, status: 'Cancelled', version: 2 });
    const row = await db.query<{ lifecycle_status: string; submitted_at: Date | null }>(
      'select lifecycle_status, submitted_at from applications where id = $1', [DRAFT_APPLICATION]);
    expect(row.rows[0]?.lifecycle_status).toBe('Cancelled');
    expect(row.rows[0]?.submitted_at).not.toBeNull();
  });

  it('lets an officer finalize a Draft too, not only the applicant who owns it', async () => {
    // actors: ['applicant', 'staff'] -- widened for the walk-in case, where a
    // colleague other than the one who started the draft needs to finish or
    // discard it. staff_permit_access still gates it the same as any other
    // staff move (seed() grants the officer every permit type).
    await markIdentityVerified(DRAFT_APPLICATION);

    const result = await service.transition({
      applicationId: DRAFT_APPLICATION, caller: officer, to: 'Submitted',
    });

    expect(result.ok).toBe(true);
  });

  it('leaves a later, already-filed application\'s submitted_at alone', async () => {
    // The CASE guards on "submitted_at is null" specifically so this is a
    // no-op for every transition that does not originate at Draft -- proven
    // here against the ordinary Submitted seed application.
    const before = await db.query<{ submitted_at: Date }>(
      'select submitted_at from applications where id = $1', [APPLICATION]);

    await service.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const after = await db.query<{ submitted_at: Date }>(
      'select submitted_at from applications where id = $1', [APPLICATION]);
    expect(after.rows[0]?.submitted_at).toEqual(before.rows[0]?.submitted_at);
  });
});
