import { SqlClient } from '../../../persistence/sql-client';
import { lookup, remember, requestDigest } from '../../../persistence/idempotency';
import { AuditService } from '../../compliance/application/audit.service';
import { deepLinkFor, entryFor } from '../../notifications/domain/catalog';
import { ApplicationSnapshot, Caller } from '../domain/application';
import { DomainEvent, decide } from '../domain/lifecycle-engine';
import { LifecycleStatus } from '../domain/lifecycle';
import { Refusal } from '../domain/lifecycle-errors';
import { loadTransitions } from '../domain/transition-repository';
import { StaffNotificationService } from '../../notifications/application/staff-notification.service';

/**
 * Moves an application, and records everything that follows, atomically.
 *
 * The decision is made by the pure engine; this class does the two things the
 * engine deliberately cannot: read the snapshot, and commit the consequences.
 *
 * Everything happens in ONE transaction — the status change, the audit event,
 * and the notifications. That is what makes "a committed transition always
 * notifies, and a rolled-back one never does" true rather than aspirational. A
 * notification sent outside the transaction can be sent for a transition that
 * then fails, which tells an applicant their permit is ready when it is not.
 */

export type TransitionResult =
  | {
      readonly ok: true;
      readonly status: LifecycleStatus;
      readonly version: number;
      /** True when this call did nothing because the same key already had. */
      readonly replayed?: boolean;
    }
  | { readonly ok: false; readonly refusal: Refusal }
  /** The same idempotency key was used for a different request. */
  | { readonly ok: false; readonly reused: true };

interface SnapshotRow {
  id: string;
  applicant_account_id: string;
  lifecycle_status: LifecycleStatus;
  version: number;
  identity_document_verified: boolean;
  required_documents_present: boolean;
  open_instruction_count: number;
  evaluations_complete: boolean;
  order_of_payment_issued: boolean;
  payment_proof_submitted: boolean;
  payment_verified: boolean;
  permit_generated: boolean;
}

/**
 * One query assembles every fact a transition decision depends on.
 *
 * Deliberately one round trip rather than eight: the snapshot must be
 * internally consistent, and eight separate reads can straddle another
 * officer's commit and produce a decision about a state that never existed.
 */
const SNAPSHOT_SQL = `
  select
    a.id,
    acc.id as applicant_account_id,
    a.lifecycle_status,
    a.version,
    exists (
      select 1 from documents d
       where d.application_id = a.id and d.label ilike '%identity%'
         and d.status = 'Approved' and d.scan_cleared
    ) as identity_document_verified,
    not exists (
      select 1 from documents d
       where d.application_id = a.id and d.status in ('Missing', 'Rejected')
    ) as required_documents_present,
    (
      select count(*)::int from instruction_items ii
        join letters_of_instruction l on l.id = ii.letter_id
       where l.application_id = a.id and ii.resolved_at is null
    ) as open_instruction_count,
    not exists (
      select 1 from evaluations e where e.application_id = a.id and e.result = 'Pending'
    ) and exists (
      select 1 from evaluations e where e.application_id = a.id
    ) as evaluations_complete,
    exists (
      select 1 from orders_of_payment o
       where o.application_id = a.id and o.superseded_at is null
    ) as order_of_payment_issued,
    exists (select 1 from payments p where p.application_id = a.id) as payment_proof_submitted,
    exists (
      select 1 from payments p where p.application_id = a.id and p.verified_at is not null
    ) as payment_verified,
    exists (select 1 from generated_permits g where g.application_id = a.id) as permit_generated
  from applications a
  join applicants ap on ap.id = a.applicant_id
  join accounts acc on acc.id = ap.account_id
  where a.id = $1
`;

export class LifecycleService {
  private readonly audit: AuditService;
  private readonly staffNotices: StaffNotificationService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
    staffNotices?: StaffNotificationService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
    // Constructed by default rather than left optional. A collaborator that is
    // allowed to be absent does nothing quietly when it is, and "no officer was
    // told" is not a state this should be able to reach by omission.
    this.staffNotices = staffNotices ?? new StaffNotificationService(db);
  }

  async snapshot(applicationId: string, client: SqlClient = this.db): Promise<ApplicationSnapshot | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(applicationId)) return null;
    const result = await client.query<SnapshotRow>(SNAPSHOT_SQL, [applicationId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      applicantAccountId: row.applicant_account_id,
      status: row.lifecycle_status,
      version: row.version,
      identityDocumentVerified: row.identity_document_verified,
      requiredDocumentsPresent: row.required_documents_present,
      openInstructionCount: row.open_instruction_count,
      evaluationsComplete: row.evaluations_complete,
      orderOfPaymentIssued: row.order_of_payment_issued,
      paymentProofSubmitted: row.payment_proof_submitted,
      paymentVerified: row.payment_verified,
      permitGenerated: row.permit_generated,
    };
  }

  async transition(options: {
    applicationId: string;
    caller: Caller;
    to: LifecycleStatus;
    expectedVersion?: number;
    remarks?: string;
    /**
     * Optional here and required by the transport. The domain accepts a move
     * without one so a test or a background job can make it; a human clicking
     * a button always has one, and the transport is where that is enforced.
     */
    idempotencyKey?: string;
  }): Promise<TransitionResult> {
    const { applicationId, caller, to, expectedVersion, remarks, idempotencyKey } = options;
    const digest = requestDigest({ applicationId, to, remarks: remarks ?? null });

    return this.db.transaction(async (tx) => {
      if (idempotencyKey !== undefined) {
        const seen = await lookup<{ status: LifecycleStatus; version: number }>(tx, {
          accountId: caller.accountId, key: idempotencyKey,
          operation: 'application.transition', digest,
        });
        if (seen.kind === 'mismatch') return { ok: false, reused: true };
        if (seen.kind === 'replay') {
          // The officer's first attempt did happen; only its answer was lost.
          // Telling them so is the whole point -- the alternative is a 412 that
          // blames a colleague for their own click.
          return { ok: true, ...seen.previous.body, replayed: true };
        }
      }

      // Locked for the duration. Without this, two officers reading the same
      // version both decide "allowed" and the second overwrites the first --
      // the version column would catch it, but only after both had already
      // written their audit events and notifications.
      const locked = await tx.query<{ id: string }>(
        'select id from applications where id = $1 for update',
        [applicationId],
      );
      if (locked.rows.length === 0) {
        return { ok: false, refusal: { kind: 'stale-version', expected: expectedVersion ?? 0, actual: -1 } };
      }

      const snapshot = await this.snapshot(applicationId, tx);
      if (snapshot === null) {
        return { ok: false, refusal: { kind: 'stale-version', expected: expectedVersion ?? 0, actual: -1 } };
      }

      // Read inside the transaction, so a decision is made against the rules
      // as they stand at that moment. Not cached: an LGU that edits the
      // lifecycle and finds the next transition still refused by the old table
      // would reasonably conclude the edit did not work, and a cache invalidated
      // by hand is a cache that is wrong on the day it matters.
      const rules = await loadTransitions(tx);

      const decision = decide({
        rules,
        snapshot,
        caller,
        to,
        now: this.clock(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(remarks === undefined ? {} : { remarks }),
      });

      if (!decision.ok) {
        // A refused move must leave no trace of having happened, beyond the
        // security audit the transport layer writes for the attempt itself.
        return { ok: false, refusal: decision.refusal };
      }

      // The database trigger writes the timeline row and bumps the version, so
      // this update is the single source of both. Guarding on the version we
      // decided against closes the window between the read and the write.
      const updated = await tx.query(
        `update applications
            set lifecycle_status = $1,
                updated_by = $2,
                pledge_suspended_since = case when $3 then now() else null end
          where id = $4 and version = $5`,
        [to, caller.accountId, decision.outcome.pledgeSuspended, applicationId, snapshot.version],
      );

      if (updated.rowCount === 0) {
        return {
          ok: false,
          refusal: { kind: 'stale-version', expected: snapshot.version, actual: -1 },
        };
      }

      await this.recordEvents(tx, decision.outcome.events, caller, snapshot);

      // TAB 14 / D-7. Told with the SAME rules the move was decided under, so a
      // workflow edit landing between the two cannot make the notice and the
      // transition disagree about who is waiting. Inside the transaction for
      // the same reason the applicant's notice is: an officer sent to an
      // application that rolled back is worse than not being told.
      {
        const reference = await tx.query<{ reference_number: string }>(
          'select reference_number from applications where id = $1', [applicationId],
        );
        await this.staffNotices.announceArrival({
          tx,
          applicationId,
          reference: reference.rows[0]?.reference_number ?? applicationId,
          status: to,
          rules,
          // Never told about their own act. An officer who has just moved an
          // application knows where it is.
          actingAccountId: caller.accountId,
        });
      }

      const result = { status: to, version: decision.outcome.nextVersion };
      if (idempotencyKey !== undefined) {
        // Inside the same transaction as the move. Recorded outside one, a
        // rolled-back transition leaves a key that replays a result nothing
        // produced.
        await remember(tx, {
          accountId: caller.accountId, key: idempotencyKey,
          operation: 'application.transition', digest, status: 200, body: result,
        });
      }

      return { ok: true, ...result };
    });
  }

  /**
   * Writes the audit event and queues the notifications, inside the caller's
   * transaction.
   *
   * The notification rows are the transactional outbox: committed with the
   * status change, delivered afterwards by a separate reader (TAB 08). That is
   * the only arrangement in which "exactly once, and only if it happened" holds
   * across a process crash.
   */
  private async recordEvents(
    tx: SqlClient,
    events: readonly DomainEvent[],
    caller: Caller,
    snapshot: ApplicationSnapshot,
  ): Promise<void> {
    for (const event of events) {
      if (event.type === 'application.transitioned') {
        // Chained, so removing this row later breaks every row after it.
        await this.audit.append(
          {
            action: 'application.transitioned',
            subjectType: 'application',
            subjectId: snapshot.id,
            outcome: 'allowed',
            actorAccountId: caller.accountId,
            actorRole: caller.kind,
            beforeState: { status: event.payload.from },
            afterState: { status: event.payload.to, remarks: event.payload.remarks ?? null },
          },
          tx,
        );
        continue;
      }

      // The copy comes from the catalog, which is the closed list of things the
      // LGU says to an applicant. A type with no catalog entry writes nothing
      // rather than an improvised message — the LGU must be able to account for
      // exactly what it told someone.
      const catalogEntry = entryFor(event.type);
      if (catalogEntry === undefined) continue;

      await tx.query(
        `insert into notifications (account_id, type, application_id, title, body, deep_link)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          snapshot.applicantAccountId,
          event.type,
          snapshot.id,
          catalogEntry.title,
          catalogEntry.body,
          deepLinkFor(catalogEntry, snapshot.id),
        ],
      );
    }
  }
}
