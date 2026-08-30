import { SqlClient } from '../../persistence/sql-client';
import { StructuredLogger } from '../logging/logger';
import { Job } from './job-runner';
import { AuditService } from '../../modules/compliance/application/audit.service';
import { DocumentService } from '../../modules/documents/application/document.service';
import { NotificationService } from '../../modules/notifications/application/notification.service';
import { DataExportService } from '../../modules/compliance/application/data-export.service';
import { deepLinkFor, entryFor } from '../../modules/notifications/domain/catalog';
import { LifecycleStatus } from '../../modules/applications/domain/lifecycle';
import { loadTransitions } from '../../modules/applications/domain/transition-repository';
import { assessmentOverdue } from '../../modules/notifications/domain/staff-catalog';
import { StaffNotificationService } from '../../modules/notifications/application/staff-notification.service';

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
 * Tells an applicant their Order of Payment has fallen due.
 *
 * ── What "overdue" attaches to ──────────────────────────────────────────
 *
 * The Order, not the payment. A `payments` row exists only once somebody has
 * submitted proof, so the applicant who worries the LGU most — the one who has
 * paid nothing at all — has no payment row to mark. Sweeping payments would
 * find every case except the one that matters.
 *
 * So the sweep reads Orders in force whose `due_date` has passed with nothing
 * verified against them, and it also moves any payment still sitting unverified
 * on such an Order to 'Overdue', because a proof submitted and never confirmed
 * is not a settled fee.
 *
 * ── It does not move the application ────────────────────────────────────
 *
 * `Assessed -> Expired` is a legal transition and this job does not make it.
 * Expiring an application ends it, and ending someone's application because a
 * date passed while nobody looked is a decision the LGU takes, not a
 * consequence of a cron entry. The transition table is also the only thing that
 * knows which moves are legal from where — the same boundary the payment
 * exceptions in TAB 07 respect.
 *
 * ── Once per Order ──────────────────────────────────────────────────────
 *
 * `payment-overdue` is a statutory notice: it starts a clock the applicant can
 * miss. Sending it again every time the job runs would train them to ignore it,
 * so an Order that has already produced one is skipped. The check is against
 * the notification rows rather than a flag, because the notification IS the
 * record of having told them.
 *
 * ── And the office is told too, since 2026-08-30 ────────────────────────
 *
 * `assessment-overdue` was seeded as a staff notice type on the day the staff
 * worklist was built and never emitted by anything. The consequence was that an
 * applicant who simply stopped paying produced a notice to THEM and silence in
 * the office: the application sat at Assessed, which routes to nobody by design
 * because in the ordinary course the applicant is the one acting. Nothing ever
 * told an officer that had stopped being true.
 *
 * Written in the SAME transaction as the applicant's notice, so the two cannot
 * disagree about whether an Order went overdue. Once per Order for free: the
 * query above skips any Order that already produced a `payment-overdue`, so
 * this branch never runs twice for the same one.
 */
export function overdueAssessmentJob(
  db: SqlClient,
  staffNotices: StaffNotificationService,
  clock: () => Date = () => new Date(),
): Job {
  return {
    name: 'overdue-assessments',
    leaseSeconds: 300,
    async run(): Promise<string> {
      const now = clock();

      const due = await db.query<{
        id: string; application_id: string; account_id: string; number: string;
        reference_number: string; lifecycle_status: LifecycleStatus;
      }>(
        `select o.id, o.application_id, acc.id as account_id, o.number,
                a.reference_number, a.lifecycle_status
           from orders_of_payment o
           join applications a on a.id = o.application_id
           join applicants ap on ap.id = a.applicant_id
           join accounts acc on acc.id = ap.account_id
          where o.superseded_at is null
            and o.due_date is not null
            and o.due_date < $1::date
            and a.archived_at is null
            -- Nothing settled against it. A verified payment means the fee was
            -- paid, whenever it was paid.
            and not exists (
              select 1 from payments p
               where p.order_of_payment_id = o.id and p.status = 'Paid')
            -- And they have not already been told about this Order.
            and not exists (
              select 1 from notifications n
               where n.application_id = o.application_id and n.type = 'payment-overdue')`,
        [now],
      );

      if (due.rows.length === 0) return 'nothing overdue';

      const entry = entryFor('payment-overdue');
      for (const order of due.rows) {
        await db.transaction(async (tx) => {
          // Unverified proof against an overdue Order is not a settled fee. A
          // payment already Voided, Reversed or Refunded is left alone: those
          // say something specific about what happened to the money, and
          // overwriting them with 'Overdue' would lose it.
          await tx.query(
            `update payments set status = 'Overdue'
              where order_of_payment_id = $1
                and status in ('Not Yet Available', 'Pending Verification')`,
            [order.id],
          );

          if (entry !== undefined) {
            await tx.query(
              `insert into notifications (account_id, type, application_id, title, body, deep_link)
               values ($1, $2, $3, $4, $5, $6)`,
              [order.account_id, entry.type, order.application_id, entry.title, entry.body,
               deepLinkFor(entry, order.application_id)],
            );
          }

          // Read inside the transaction, and read at all rather than using the
          // compiled table: since D-5 the rules are configuration, and an LGU
          // that moved `Assessed -> Expired` to a different scope expects this
          // notice to follow it.
          await staffNotices.announceStall({
            tx,
            applicationId: order.application_id,
            status: order.lifecycle_status,
            rules: await loadTransitions(tx),
            notice: assessmentOverdue(
              order.number, order.reference_number, order.application_id,
            ),
          });
        });
      }

      return `${due.rows.length} Order(s) of Payment overdue; applicants notified`;
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
