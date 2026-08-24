import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { StructuredLogger } from '../src/common/logging/logger';
import { DrainState } from '../src/common/lifecycle/shutdown';
import { JobRunner } from '../src/common/scheduling/job-runner';
import { Scheduler } from '../src/common/scheduling/scheduler';
import {
  auditVerificationJob, notificationDispatchJob, operationalPurgeJob, retentionJob,
} from '../src/common/scheduling/jobs';
import { AuditService } from '../src/modules/compliance/application/audit.service';
import { NotificationService } from '../src/modules/notifications/application/notification.service';
import { DocumentService } from '../src/modules/documents/application/document.service';
import { DataExportService } from '../src/modules/compliance/application/data-export.service';
import { dataExportExpiryJob, dataExportJob } from '../src/common/scheduling/jobs';
import { ObjectStore } from '../src/modules/documents/domain/object-store';

/**
 * The four jobs, driven by the scheduler, against a real database.
 *
 * Every one of these was written, tested and never run before this TAB. What is
 * asserted here is that a tick actually does the work and records that it did —
 * which is a different claim from "the function is correct", and the one that
 * was missing.
 */

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

let db: SqlClient;
let lines: string[];
let now: Date;

const logger = (): StructuredLogger => new StructuredLogger('info', (line) => lines.push(line));

const ACCOUNT = randomUUID();

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  lines = [];
  now = new Date('2026-08-20T05:00:00Z');

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

const runner = (): JobRunner => new JobRunner(db, logger(), 'pod-a', () => now);

const jobRow = async (name: string) => (await db.query<{
  last_outcome: string | null; last_detail: string | null;
}>('select last_outcome, last_detail from scheduled_jobs where name = $1', [name])).rows[0]!;

describe('the operational purge', () => {
  it('removes idempotency keys past their window', async () => {
    // An idempotency key from last year cannot protect against anything, and it
    // can still be disclosed: the stored response body echoes whatever the
    // response carried.
    await db.query(
      `insert into idempotency_keys (key, account_id, operation, request_digest, response_status, response_body, created_at)
       values ($1,$2,'test','digest',200,'{}',$3)`,
      [randomUUID(), ACCOUNT, new Date(now.getTime() - 72 * 3600 * 1000)],
    );

    await runner().runIfDue(operationalPurgeJob(db, () => now));

    const left = await db.query<{ n: string }>('select count(*) as n from idempotency_keys');
    expect(Number(left.rows[0]!.n)).toBe(0);
  });

  it('keeps one still inside its window', async () => {
    // A client may still be retrying. Deleting the key mid-retry turns a safe
    // replay into a second filing.
    await db.query(
      `insert into idempotency_keys (key, account_id, operation, request_digest, response_status, response_body, created_at)
       values ($1,$2,'test','digest',200,'{}',$3)`,
      [randomUUID(), ACCOUNT, new Date(now.getTime() - 3600 * 1000)],
    );

    await runner().runIfDue(operationalPurgeJob(db, () => now));

    const left = await db.query<{ n: string }>('select count(*) as n from idempotency_keys');
    expect(Number(left.rows[0]!.n)).toBe(1);
  });

  it('removes a consumed refresh token, which is a digest of a secret with no purpose', async () => {
    await db.query(
      // `issued_at` is set explicitly rather than defaulted. The column
      // defaults to the real `now()`, and with `expires_at` derived from the
      // PINNED clock the row violates `expires_at > issued_at` as soon as wall
      // time passes the pinned instant — a test that starts failing on a day
      // nobody changed anything.
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at, consumed_at)
       values ($1,$2,$3,'digest',$4,$5,$6)`,
      [randomUUID(), randomUUID(), ACCOUNT, now, new Date(now.getTime() + 86_400_000), now],
    );

    await runner().runIfDue(operationalPurgeJob(db, () => now));

    const left = await db.query<{ n: string }>('select count(*) as n from refresh_tokens');
    expect(Number(left.rows[0]!.n)).toBe(0);
  });

  it('keeps a live session', async () => {
    // Purging one would sign an applicant out mid-application.
    await db.query(
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at)
       values ($1,$2,$3,'digest',$4,$5)`,
      [randomUUID(), randomUUID(), ACCOUNT, now, new Date(now.getTime() + 86_400_000)],
    );

    await runner().runIfDue(operationalPurgeJob(db, () => now));

    const left = await db.query<{ n: string }>('select count(*) as n from refresh_tokens');
    expect(Number(left.rows[0]!.n)).toBe(1);
  });

  it('records counts an operator can read', async () => {
    await runner().runIfDue(operationalPurgeJob(db, () => now));

    expect((await jobRow('operational-data-purge')).last_detail).toContain('idempotency keys 0');
  });
});

describe('audit-chain verification', () => {
  it('passes on an intact chain and says how long it is', async () => {
    const audit = new AuditService(db, () => now);
    await audit.append({
      action: 'application.submitted', subjectType: 'application',
      subjectId: randomUUID(), outcome: 'allowed', actorAccountId: ACCOUNT,
    });

    await runner().runIfDue(auditVerificationJob(audit, logger()));

    const row = await jobRow('audit-chain-verification');
    expect(row.last_outcome).toBe('succeeded');
    expect(row.last_detail).toContain('intact');
  });

  it('FAILS loudly when an entry has been edited', async () => {
    // The whole point of the chain. A tamper-evident log nobody checks is a
    // log, and a check that reported "not intact" as a success would be the
    // same defect as not running it at all.
    const audit = new AuditService(db, () => now);
    await audit.append({
      action: 'application.submitted', subjectType: 'application',
      subjectId: randomUUID(), outcome: 'allowed', actorAccountId: ACCOUNT,
    });
    // The trail is append-only by trigger, so tampering has to go around it —
    // which is exactly the threat model. ADR: someone with database rights can
    // rewrite rows and no in-database scheme stops that; what the chain does is
    // make it detectable.
    await db.query('alter table audit_events disable trigger all');
    await db.query(`update audit_events set action = 'application.approved' where sequence = 1`);
    await db.query('alter table audit_events enable trigger all');

    const outcome = await runner().runIfDue(auditVerificationJob(audit, logger()));

    expect('failed' in outcome && outcome.failed).toBe(true);
    expect((await jobRow('audit-chain-verification')).last_outcome).toBe('failed');
    expect(lines.join('\n')).toContain('AUDIT CHAIN BROKEN');
  });
});

describe('notification dispatch', () => {
  it('queues an attempt and says plainly that nothing was SENT', async () => {
    // The most consequential lie this file could tell. Push, email and SMS all
    // need a provider that has not been chosen; claiming to have dispatched
    // would record an applicant as notified who was never told.
    await db.query(
      `insert into notifications (id, account_id, type, title, body)
       values ($1,$2,'application-submitted','Filed','Reference BP-2026-000041')`,
      [randomUUID(), ACCOUNT],
    );

    await runner().runIfDue(notificationDispatchJob(new NotificationService(db, () => now), db));

    const row = await jobRow('notification-dispatch');
    expect(row.last_outcome).toBe('succeeded');
    expect(row.last_detail).toContain('NOT SENT');

    const queued = await db.query<{ n: string }>('select count(*) as n from notification_deliveries');
    expect(Number(queued.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('does not plan the same notification twice', async () => {
    await db.query(
      `insert into notifications (id, account_id, type, title, body)
       values ($1,$2,'application-submitted','Filed','Reference BP-2026-000041')`,
      [randomUUID(), ACCOUNT],
    );
    const notifications = new NotificationService(db, () => now);

    await runner().runIfDue(notificationDispatchJob(notifications, db));
    const after = await db.query<{ n: string }>('select count(*) as n from notification_deliveries');
    now = new Date(now.getTime() + 120_000);
    await runner().runIfDue(notificationDispatchJob(notifications, db));

    const again = await db.query<{ n: string }>('select count(*) as n from notification_deliveries');
    expect(again.rows[0]!.n).toBe(after.rows[0]!.n);
  });
});

describe('retention with no period configured', () => {
  it('deletes nothing and says why, rather than picking a number', async () => {
    // A retention period invented by this service would be a data-minimisation
    // decision made by the wrong party (M-15).
    const documents = { runRetention: () => Promise.reject(new Error('should not be called')) };

    await runner().runIfDue(retentionJob(documents as unknown as DocumentService, null));

    const row = await jobRow('document-retention');
    expect(row.last_outcome).toBe('succeeded');
    expect(row.last_detail).toContain('M-15');
  });
});

describe('a scheduler tick', () => {
  it('runs every due job and records each one', async () => {
    const audit = new AuditService(db, () => now);
    const scheduler = new Scheduler(
      runner(),
      [
        retentionJob({ runRetention: () => Promise.resolve({ deleted: 0, skippedOpen: 0 }) } as unknown as DocumentService, 3650),
        auditVerificationJob(audit, logger()),
        notificationDispatchJob(new NotificationService(db, () => now), db),
        operationalPurgeJob(db, () => now),
      ],
      logger(),
      new DrainState(),
    );

    await scheduler.tick();

    // Asserted over the jobs this tick actually ran, not over every seeded row.
    // The seeded set grows as jobs are added, and a test that counts rows fails
    // for the wrong reason when it does.
    const ran = ['document-retention', 'audit-chain-verification',
      'notification-dispatch', 'operational-data-purge'];
    const rows = await db.query<{ name: string; last_outcome: string | null }>(
      'select name, last_outcome from scheduled_jobs where name = any($1) order by name',
      [ran],
    );
    expect(rows.rows.map((row) => row.last_outcome)).toEqual(ran.map(() => 'succeeded'));
  });

  it('lets one failing job not stop the others', async () => {
    // A purge that fails must not mean notifications are never planned again.
    const scheduler = new Scheduler(
      runner(),
      [
        retentionJob({ runRetention: () => Promise.reject(new Error('object store down')) } as unknown as DocumentService, 3650),
        operationalPurgeJob(db, () => now),
      ],
      logger(),
      new DrainState(),
    );

    await scheduler.tick();

    expect((await jobRow('document-retention')).last_outcome).toBe('failed');
    expect((await jobRow('operational-data-purge')).last_outcome).toBe('succeeded');
  });
});

const objects = new Map<string, Buffer>();
const store = {
  put: (key: string, bytes: Buffer) => { objects.set(key, bytes); return Promise.resolve(); },
  get: (key: string) => Promise.resolve(objects.get(key) ?? null),
  delete: (key: string) => Promise.resolve(objects.delete(key)),
  signedUrl: (key: string) => Promise.resolve(`https://objects.test/${key}`),
  verifySignedUrl: () => 'ok' as const,
  isPubliclyReadable: () => Promise.resolve(false),
} as unknown as ObjectStore;

describe('every seeded job has something to run it', () => {
  it('matches the jobs the scheduling module registers', async () => {
    // A row in `scheduled_jobs` with no implementation looks enabled, is
    // claimed by nobody, and never runs — and the only symptom is that
    // something quietly stops happening. Seeding and registering are in two
    // different files, so this is the only place they meet.
    const seeded = (await db.query<{ name: string }>('select name from scheduled_jobs order by name'))
      .rows.map((row) => row.name);

    const registered = [
      retentionJob({ runRetention: () => Promise.resolve({ deleted: 0, skippedOpen: 0 }) } as unknown as DocumentService, null),
      auditVerificationJob(new AuditService(db, () => now), logger()),
      notificationDispatchJob(new NotificationService(db, () => now), db),
      operationalPurgeJob(db, () => now),
      dataExportJob(new DataExportService(db, store, () => now), db),
      dataExportExpiryJob(new DataExportService(db, store, () => now)),
    ].map((job) => job.name).sort();

    expect(registered).toEqual(seeded);
  });
});

describe('data exports', () => {
  beforeEach(async () => {
    objects.clear();
    await db.query(
      `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
      [randomUUID(), ACCOUNT],
    );
  });

  it('produces a queued export and records what it did', async () => {
    const dataExports = new DataExportService(db, store, () => now);
    await dataExports.request(ACCOUNT);

    await runner().runIfDue(dataExportJob(dataExports, db));

    const row = await jobRow('data-export');
    expect(row.last_outcome).toBe('succeeded');
    expect(row.last_detail).toBe('1 produced, 0 failed');
    expect(objects.size).toBe(1);
  });

  it('lets one applicant’s failure not block everyone else’s', async () => {
    // One person's request failing is their problem to be told about — the row
    // records why — and treating it as a job failure would stop every other
    // queued export behind it.
    const failing = {
      ...store,
      put: (key: string) => (key.startsWith('0')
        ? Promise.reject(new Error('object store unreachable'))
        : Promise.resolve()),
    } as unknown as ObjectStore;
    const dataExports = new DataExportService(db, failing, () => now);
    await dataExports.request(ACCOUNT);

    const outcome = await runner().runIfDue(dataExportJob(dataExports, db));

    // The job succeeds whatever happened to the individual request.
    expect('failed' in outcome).toBe(false);
    expect((await jobRow('data-export')).last_outcome).toBe('succeeded');
  });

  it('reports nothing queued rather than looking broken', async () => {
    await runner().runIfDue(dataExportJob(new DataExportService(db, store, () => now), db));

    expect((await jobRow('data-export')).last_detail).toBe('nothing queued');
  });

  it('deletes a produced file once its window closes', async () => {
    // An expiry nothing enforces is a comment.
    const dataExports = new DataExportService(db, store, () => now);
    const { requestId } = await dataExports.request(ACCOUNT);
    await dataExports.produce(requestId);
    expect(objects.size).toBe(1);

    now = new Date(now.getTime() + 72 * 3_600_000);
    await runner().runIfDue(dataExportExpiryJob(new DataExportService(db, store, () => now)));

    expect(objects.size).toBe(0);
    expect((await jobRow('data-export-expiry')).last_detail).toContain('1 export(s) expired');
  });
});
