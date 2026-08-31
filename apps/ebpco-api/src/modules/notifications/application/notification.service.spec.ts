import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../../applications/domain/application';
import { LifecycleService } from '../../applications/application/lifecycle.service';
import { DEFAULT_PREFERENCES } from '../domain/delivery';
import { NotificationService } from './notification.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
// +08:00 explicitly: quiet hours are a Manila wall clock, and these fixtures
// were `Z` times named for the Manila hour they were meant to be. `NIGHT` was
// 23:00Z — seven in the morning in Manila — so this suite agreed with the
// eight-hour slide in the planner instead of catching it.
const DAYTIME = new Date('2026-08-19T10:00:00+08:00');
const NIGHT = new Date('2026-08-19T23:00:00+08:00');

let db: SqlClient;
let notifications: NotificationService;
let lifecycle: LifecycleService;

const APPLICANT_ACCOUNT = randomUUID();
const OFFICER_ACCOUNT = randomUUID();
const APPLICATION = randomUUID();

const officer: Caller = {
  accountId: OFFICER_ACCOUNT, kind: 'staff',
  scopes: [...new Set(Object.values(ROLE_SCOPES).flat())],
};

const at = (now: Date) => new NotificationService(db, () => now);

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  notifications = at(DAYTIME);
  lifecycle = new LifecycleService(db, () => DAYTIME);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b'),
            ($2,'staff','o@lgu.gov.ph','o@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT, OFFICER_ACCOUNT],
  );
  const applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
  // Migration 032's backfill, which a direct-insert fixture skips. The
  // allow-list fails CLOSED, so without it every staff transition is refused.
  await db.query(
    'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [OFFICER_ACCOUNT, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [OFFICER_ACCOUNT]);
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000001',$2,'Fencing','New','Submitted',now(),$3)`,
    [APPLICATION, applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

describe('the outbox holds only things that happened', () => {
  // Acceptance criterion: a rolled-back transition produces no notification; a
  // committed one produces exactly one.

  it('writes one notification for a committed transition', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const feed = await notifications.feed(APPLICANT_ACCOUNT);
    expect(feed.entries.map((entry) => entry.type)).toEqual(['received-by-obo']);
  });

  it('writes NONE when the transaction rolls back', async () => {
    // The whole reason the notification is committed with the status change: a
    // notification sent for a transition that then fails tells an applicant
    // their permit is ready when it is not.
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into notifications (account_id, type, application_id, title, body)
           values ($1, 'received-by-obo', $2, 'Received', 'Body long enough to matter')`,
          [APPLICANT_ACCOUNT, APPLICATION],
        );
        throw new Error('the transition failed after the notification was queued');
      }),
    ).rejects.toThrow();

    expect((await notifications.feed(APPLICANT_ACCOUNT)).entries).toEqual([]);
  });

  it('writes none at all when the transition is refused', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Released' });

    expect((await notifications.feed(APPLICANT_ACCOUNT)).entries).toEqual([]);
  });

  it('carries the catalog copy, not improvised text', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const entry = (await notifications.feed(APPLICANT_ACCOUNT)).entries[0];
    expect(entry?.title).toBe('Received by the OBO');
    expect(entry?.body).toContain('Processing has started');
  });

  it('carries a deep link with the application substituted in', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect((await notifications.feed(APPLICANT_ACCOUNT)).entries[0]?.deepLink)
      .toBe(`/applications/${APPLICATION}`);
  });
});

describe('reading is not resolving', () => {
  // Acceptance criterion. An applicant who reads "revision required" and does
  // nothing still owes an act, and a badge that cleared on read would tell them
  // otherwise.

  const anActionRequired = async (): Promise<string> => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Revision Required' });
    const feed = await notifications.feed(APPLICANT_ACCOUNT);
    return feed.entries.find((entry) => entry.requiresAction)!.id;
  };

  it('counts unresolved actions in the badge, not unread items', async () => {
    await anActionRequired();

    const feed = await notifications.feed(APPLICANT_ACCOUNT);
    expect(feed.unresolvedCount).toBe(1);
    // Three notifications, only one of which requires an act.
    expect(feed.entries.length).toBeGreaterThan(1);
  });

  it('leaves resolvedAt null when marked read, and the badge unchanged', async () => {
    const id = await anActionRequired();

    expect(await notifications.markRead(id, APPLICANT_ACCOUNT)).toBe(true);

    const feed = await notifications.feed(APPLICANT_ACCOUNT);
    const entry = feed.entries.find((e) => e.id === id);
    expect(entry?.readAt).not.toBeNull();
    expect(entry?.resolvedAt).toBeNull();
    expect(feed.unresolvedCount).toBe(1);
  });

  it('clears the badge only when the act is actually resolved', async () => {
    const id = await anActionRequired();
    await notifications.markResolved(id, APPLICANT_ACCOUNT);

    expect((await notifications.feed(APPLICANT_ACCOUNT)).unresolvedCount).toBe(0);
  });

  it('does not let one applicant read or resolve another’s notification', async () => {
    const id = await anActionRequired();

    expect(await notifications.markRead(id, randomUUID())).toBe(false);
    expect(await notifications.markResolved(id, randomUUID())).toBe(false);
  });

  it('keeps the first read time rather than moving it on every glance', async () => {
    const id = await anActionRequired();
    await notifications.markRead(id, APPLICANT_ACCOUNT);
    const first = (await notifications.feed(APPLICANT_ACCOUNT)).entries.find((e) => e.id === id)?.readAt;

    await at(new Date('2026-08-20T10:00:00Z')).markRead(id, APPLICANT_ACCOUNT);
    const second = (await notifications.feed(APPLICANT_ACCOUNT)).entries.find((e) => e.id === id)?.readAt;

    expect(second?.toISOString()).toBe(first?.toISOString());
  });
});

describe('preferences', () => {
  it('defaults to nothing muted and quiet hours on', async () => {
    expect(await notifications.preferences(APPLICANT_ACCOUNT)).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips a mute', async () => {
    await notifications.replacePreferences(APPLICANT_ACCOUNT, {
      mutedCategories: ['applicationUpdates'],
      quietHours: { enabled: true, start: '22:00', end: '06:00' },
    });

    expect(await notifications.preferences(APPLICANT_ACCOUNT)).toEqual({
      mutedCategories: ['applicationUpdates'],
      quietHours: { enabled: true, start: '22:00', end: '06:00' },
    });
  });

  it('is held server-side, so a reinstall does not silently re-enable everything', async () => {
    await notifications.replacePreferences(APPLICANT_ACCOUNT, {
      mutedCategories: ['payments'], quietHours: DEFAULT_PREFERENCES.quietHours,
    });

    // A fresh service instance is the closest thing to a reinstall.
    expect((await at(DAYTIME).preferences(APPLICANT_ACCOUNT)).mutedCategories).toEqual(['payments']);
  });
});

describe('draining the outbox', () => {
  const withDevice = async (): Promise<void> => {
    await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'android',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('encrypted'),
    });
  };

  it('plans email for every notification', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const attempts = await notifications.planPending();
    expect(attempts.map((a) => a.channel)).toContain('email');
  });

  it('plans push only when a device is registered', async () => {
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect((await notifications.planPending()).map((a) => a.channel)).not.toContain('push');
  });

  it('plans push once a device is registered', async () => {
    await withDevice();
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect((await notifications.planPending()).map((a) => a.channel)).toContain('push');
  });

  it('records the feed entry but plans no push when the category is muted', async () => {
    // Acceptance criterion: a muted category still records a feed entry and
    // sends no push.
    await withDevice();
    await notifications.replacePreferences(APPLICANT_ACCOUNT, {
      mutedCategories: ['applicationUpdates'], quietHours: DEFAULT_PREFERENCES.quietHours,
    });
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const attempts = await notifications.planPending();

    expect((await notifications.feed(APPLICANT_ACCOUNT)).entries).toHaveLength(1);
    expect(attempts.map((a) => a.channel)).not.toContain('push');
    expect(attempts.map((a) => a.channel)).toContain('email');
  });

  it('defers rather than drops a push generated inside quiet hours', async () => {
    // Acceptance criterion.
    await withDevice();
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const attempts = await at(NIGHT).planPending();
    const push = attempts.find((a) => a.channel === 'push');

    expect(push).toBeDefined();
    // 07:00 on the 20th in Manila, i.e. 23:00Z on the 19th.
    expect(push?.deferredUntil?.toISOString()).toBe('2026-08-19T23:00:00.000Z');
  });

  it('plans each notification once', async () => {
    await withDevice();
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    expect((await notifications.planPending()).length).toBeGreaterThan(0);
    expect(await notifications.planPending()).toEqual([]);
  });

  it('records the planned attempts and marks the row dispatched atomically', async () => {
    // The property the outbox rests on, tested across the boundary it used to
    // straddle. `dispatched_at` was set by the service and the attempts were
    // inserted by the caller afterwards, so a crash in between produced a
    // notification marked dispatched with nothing recorded against it — and
    // nothing revisits a dispatched row. Silently lost, which for a statutory
    // notice is the worst outcome available.
    //
    // Simulated by failing the delivery insert, which is the statement that
    // used to be outside the transaction.
    await withDevice();
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const failing: SqlClient = {
      query: db.query.bind(db),
      exec: db.exec.bind(db),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: (async (sql: string, params?: unknown[]) => {
              if (sql.includes('insert into notification_deliveries')) {
                throw new Error('provider table unavailable');
              }
              return tx.query(sql, params);
            }),
            exec: tx.exec.bind(tx),
            transaction: tx.transaction.bind(tx),
            close: tx.close.bind(tx),
          }),
        ),
      close: db.close.bind(db),
    };

    await expect(new NotificationService(failing, () => DAYTIME).planPending()).rejects.toThrow(
      'provider table unavailable',
    );

    // Still pending, so the next run plans it again. At-least-once.
    const pending = await db.query<{ count: number }>(
      'select count(*)::int as count from notifications where dispatched_at is null',
    );
    expect(pending.rows[0]?.count).toBe(1);

    const rows = await db.query<{ count: number }>(
      'select count(*)::int as count from notification_deliveries',
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('writes one delivery row per planned channel, and is safe to run twice', async () => {
    await withDevice();
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const attempts = await notifications.planPending();

    const rows = await db.query<{ channel: string; status: string }>(
      'select channel, status from notification_deliveries order by channel',
    );
    expect(rows.rows.map((r) => r.channel).sort()).toEqual([...attempts.map((a) => a.channel)].sort());
    expect(rows.rows.every((r) => r.status === 'queued')).toBe(true);
  });

  it('leaves a row pending if planning never completes, erring toward at-least-once', async () => {
    // A duplicate notification is an annoyance; a missing one is a missed
    // deadline.
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const pending = await db.query<{ count: number }>(
      'select count(*)::int as count from notifications where dispatched_at is null',
    );
    expect(pending.rows[0]?.count).toBe(1);
  });
});

describe('devices', () => {
  it('registers one and returns its id', async () => {
    const id = await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'ios',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('x'),
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not duplicate the same token, it refreshes it', async () => {
    const first = await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'ios',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('x'), appVersion: '1.0.0',
    });
    const second = await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'ios',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('x'), appVersion: '1.1.0',
    });

    expect(second).toBe(first);
    const count = await db.query<{ count: number }>('select count(*)::int as count from devices');
    expect(count.rows[0]?.count).toBe(1);
  });

  it('prunes a token the provider reported as gone', async () => {
    const id = await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'android',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('x'),
    });

    expect(await notifications.pruneDevice(id)).toBe(true);
    expect(await notifications.pruneDevice(id)).toBe(false);
  });

  it('never returns the push token itself', async () => {
    // It is a credential for reaching the device and has no business travelling
    // back out of the API.
    await notifications.registerDevice({
      accountId: APPLICANT_ACCOUNT, platform: 'android',
      pushTokenDigest: 'digest-1', pushTokenEncrypted: Buffer.from('the-real-token'),
    });

    const feed = await notifications.feed(APPLICANT_ACCOUNT);
    expect(JSON.stringify(feed)).not.toContain('the-real-token');
  });
});
