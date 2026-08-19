import { SqlClient } from '../../../persistence/sql-client';
import { ApplicationSnapshot, Caller } from '../domain/application';
import { DomainEvent, decide } from '../domain/lifecycle-engine';
import { LifecycleStatus } from '../domain/lifecycle';
import { Refusal } from '../domain/lifecycle-errors';

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
  | { readonly ok: true; readonly status: LifecycleStatus; readonly version: number }
  | { readonly ok: false; readonly refusal: Refusal };

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
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
  }): Promise<TransitionResult> {
    const { applicationId, caller, to, expectedVersion, remarks } = options;

    return this.db.transaction(async (tx) => {
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

      const decision = decide({
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

      return { ok: true, status: to, version: decision.outcome.nextVersion };
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
        await tx.query(
          `insert into audit_events (actor_account_id, actor_role, action, subject_type, subject_id,
                                     outcome, before_state, after_state, entry_hash)
           values ($1, $2, $3, 'application', $4, 'allowed', $5, $6, $7)`,
          [
            caller.accountId,
            caller.kind,
            'application.transitioned',
            snapshot.id,
            JSON.stringify({ status: event.payload.from }),
            JSON.stringify({ status: event.payload.to, remarks: event.payload.remarks ?? null }),
            // TAB 09 replaces this with a real hash chain over the previous row.
            'pending-chain',
          ],
        );
        continue;
      }

      await tx.query(
        `insert into notifications (account_id, type, application_id, title, body)
         select $1, $2, $3, $4, $5
          where exists (select 1 from notification_types where type = $2)`,
        [
          snapshot.applicantAccountId,
          event.type,
          snapshot.id,
          titleFor(event.type),
          bodyFor(event.type),
        ],
      );
    }
  }
}

/**
 * Placeholder copy. TAB 08 owns the wording, and it will be reviewed with the
 * LGU because a notification is the LGU speaking to an applicant. Keyed off the
 * catalog type so the mapping is total and a new type cannot ship unworded.
 */
function titleFor(type: string): string {
  return type.replace(/^application\./, '').replace(/-/g, ' ');
}

function bodyFor(type: string): string {
  return `Your application has been updated: ${titleFor(type)}.`;
}
