import { SqlClient } from '../../persistence/sql-client';
import { StructuredLogger } from '../logging/logger';
import { Job } from './job-runner';
import { AuditService } from '../../modules/compliance/application/audit.service';
import { DocumentService } from '../../modules/documents/application/document.service';
import { NotificationService } from '../../modules/notifications/application/notification.service';
import { DataExportService } from '../../modules/compliance/application/data-export.service';

/**
 * The four jobs, and what each is allowed to claim about itself.
 *
 * Every one returns a short line for `scheduled_jobs.last_detail`, because "it
 * ran" is not the question an operator has at 9am. "It deleted 0 and held back
 * 412" is.
 */

/**
 * Deletes documents whose application closed longer ago than the LGU keeps
 * them.
 *
 * `retainForDays` has no default here and must be configured. A retention
 * period invented by this service would be a data-minimisation decision made by
 * the wrong party (M-15) — so with none set the job reports that rather than
 * quietly picking a number, and deletes nothing.
 */
export function retentionJob(
  documents: DocumentService,
  retainForDays: number | null,
): Job {
  return {
    name: 'document-retention',
    // Long, because deleting from object storage is per-file network work and a
    // backlog can be large. A second replica joining halfway is harmless — the
    // deletes are idempotent — but wasteful.
    leaseSeconds: 900,
    async run(): Promise<string> {
      if (retainForDays === null) {
        return 'no retention period configured (M-15); nothing deleted';
      }
      const outcome = await documents.runRetention(retainForDays);
      return `deleted ${outcome.deleted}, held back ${outcome.skippedOpen} on open applications`;
    },
  };
}

/**
 * Reads the whole chain and checks every link.
 *
 * A tamper-evident log nobody checks is a log. The point of the chain is that
 * tampering is detectable, and detection that never runs is the same as no
 * detection at all.
 *
 * A broken chain does NOT take the instance out of rotation. The evidence is
 * historical and refusing traffic would not protect it; what it needs is a
 * person, which is why this logs at error and records the failure.
 */
export function auditVerificationJob(audit: AuditService, logger: StructuredLogger): Job {
  return {
    name: 'audit-chain-verification',
    leaseSeconds: 1800,
    async run(): Promise<string> {
      const verdict = await audit.verify();
      if (verdict.intact) return `chain intact, ${verdict.length} entries`;

      // Thrown so the runner records a failure and the consecutive count
      // climbs. A verification that quietly returned "not intact" as a success
      // would be the same defect as not running it.
      logger.error('AUDIT CHAIN BROKEN', { verdict });
      throw new Error(`audit chain broken at sequence ${verdict.brokenAtSequence}: ${verdict.reason}`);
    },
  };
}

/**
 * Plans delivery for notifications nobody has planned yet.
 *
 * Planning only. Nothing here sends anything: push, email and SMS all need a
 * provider that has not been chosen (E-1, M-27), and the planned attempts are
 * recorded so that whatever is chosen has a queue to read. Claiming this
 * "dispatches" would be the most consequential lie in this file — an applicant
 * would be recorded as notified and never told.
 */
export function notificationDispatchJob(notifications: NotificationService): Job {
  return {
    name: 'notification-dispatch',
    // Short: it runs every minute and does bounded work.
    leaseSeconds: 120,
    async run(): Promise<string> {
      // The planned attempts are recorded by `planPending` itself, in the same
      // transaction that marks each notification dispatched. This job used to
      // insert them here, one statement later and outside that transaction,
      // which meant a crash in between marked a notice delivered-planned while
      // recording no attempt — and nothing ever revisits a dispatched row.
      const attempts = await notifications.planPending(200);
      if (attempts.length === 0) return 'nothing pending';
      return `${attempts.length} attempt(s) queued; NOT SENT — no delivery provider is configured`;
    },
  };
}

/**
 * Removes rows whose only reason to exist has expired.
 *
 * These are erased with an account, and they accumulate for accounts that are
 * never erased — which is most of them. Each window is short and each row is
 * disposable, which is exactly what makes them worth deleting rather than
 * keeping "just in case": an idempotency key from last year cannot protect
 * against anything, and it can still be disclosed.
 */
export function operationalPurgeJob(db: SqlClient, clock: () => Date = () => new Date()): Job {
  return {
    name: 'operational-data-purge',
    leaseSeconds: 600,
    async run(): Promise<string> {
      const now = clock();
      // 48 hours. Long enough to cover any retry a client will still be making,
      // short enough that a stored response body is not a standing disclosure.
      const idempotencyCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      const keys = await db.query(
        'delete from idempotency_keys where created_at < $1', [idempotencyCutoff],
      );
      // Expired or already consumed: neither can authenticate anything, and a
      // consumed token kept is a digest of a secret with no purpose.
      const tokens = await db.query(
        'delete from refresh_tokens where expires_at < $1 or consumed_at is not null or revoked_at is not null',
        [now],
      );
      const tickets = await db.query(
        'delete from password_reset_tickets where expires_at < $1 or used_at is not null', [now],
      );
      // A revocation record protects nothing once the access tokens it refers
      // to have expired on their own.
      const revocations = await db.query(
        'delete from revoked_sessions where expires_at < $1', [now],
      );

      return `idempotency keys ${keys.rowCount}, refresh tokens ${tokens.rowCount}, `
        + `reset tickets ${tickets.rowCount}, session revocations ${revocations.rowCount}`;
    },
  };
}

/**
 * Produces queued data exports.
 *
 * Bounded per run rather than draining the queue: an export reads an
 * applicant's whole record, and a burst of requests should not hold a
 * connection from the pool for minutes while people are filing applications.
 * The job runs every two minutes, so a backlog clears steadily.
 *
 * A failed export does NOT fail the job. One applicant's request failing is
 * their problem to be told about — the row records why — and treating it as a
 * job failure would stop every other queued export behind it.
 */
export function dataExportJob(dataExports: DataExportService, db: SqlClient, batch = 5): Job {
  return {
    name: 'data-export',
    leaseSeconds: 600,
    async run(): Promise<string> {
      const queued = await db.query<{ id: string }>(
        `select id from data_export_requests where status = 'queued'
          order by requested_at limit $1`,
        [batch],
      );
      if (queued.rows.length === 0) return 'nothing queued';

      let produced = 0;
      let failed = 0;
      for (const row of queued.rows) {
        const outcome = await dataExports.produce(row.id);
        if (outcome.ok) produced += 1;
        else failed += 1;
      }

      return `${produced} produced, ${failed} failed`;
    },
  };
}

/**
 * Deletes produced exports once their window closes.
 *
 * The other half of the promise the expiry makes. A portable copy of somebody's
 * entire permit history left on storage indefinitely is a standing disclosure,
 * and an expiry nothing enforces is a comment.
 */
export function dataExportExpiryJob(dataExports: DataExportService): Job {
  return {
    name: 'data-export-expiry',
    leaseSeconds: 600,
    async run(): Promise<string> {
      const { expired } = await dataExports.sweepExpired();
      return `${expired} export(s) expired and deleted`;
    },
  };
}
