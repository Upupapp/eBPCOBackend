import { SqlClient } from '../../../persistence/sql-client';
import { lookup, remember, requestDigest } from '../../../persistence/idempotency';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';

/**
 * Filing an application, exactly once.
 *
 * The idempotency key is not decoration here — it is the whole reason this is a
 * service rather than an INSERT. The mobile client queues submissions offline
 * (TAB 12) and replays them when the connection returns, and the case that
 * matters is a submission the server committed whose response was lost. Without
 * the key that replay is a second building permit for the same fence; with it,
 * the applicant gets the original back.
 *
 * The applicant supplies almost nothing that matters. Lifecycle status,
 * classification, charter entry, reference number and the filing timestamp are
 * all set here, from the LGU's own data — a client that could name its own
 * status could file an application already Approved.
 */

export type SubmitResult =
  | {
      readonly ok: true;
      readonly applicationId: string;
      readonly referenceNumber: string;
      /** True when this call did nothing because the same key already had. */
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'no-applicant-record' | 'unknown-permit-type' | 'business-not-yours'
        | 'documents-not-yours' | 'key-reused';
      readonly detail: string;
    };

export interface Submission {
  readonly permitType: string;
  readonly applicationAction: 'New' | 'Renewal' | 'Amendment';
  readonly businessId: string | null;
  readonly location: string | null;
  readonly documentIds: readonly string[];
}

export class SubmissionService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async submit(options: {
    caller: Caller;
    submission: Submission;
    idempotencyKey: string;
  }): Promise<SubmitResult> {
    const { caller, submission, idempotencyKey } = options;
    const digest = requestDigest({ ...submission, documentIds: [...submission.documentIds].sort() });

    return this.db.transaction(async (tx) => {
      const replay = await lookup<{ applicationId: string; referenceNumber: string }>(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'application.submit', digest,
      });
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'key-reused',
          detail: 'This Idempotency-Key was already used for a different application. Use a new key.',
        };
      }
      if (replay.kind === 'replay') {
        return { ok: true, ...replay.previous.body, replayed: true };
      }

      const applicant = await tx.query<{ id: string }>(
        'select id from applicants where account_id = $1',
        [caller.accountId],
      );
      const applicantId = applicant.rows[0]?.id;
      if (applicantId === undefined) {
        // A staff account, or an applicant account with no applicant record.
        // Refused rather than created on the fly: an applicant record carries a
        // name that belongs on a permit, and inventing one from an email
        // address puts a guess on a legal document.
        return {
          ok: false, reason: 'no-applicant-record',
          detail: 'This account has no applicant profile. Complete your profile before filing.',
        };
      }

      const permitType = await tx.query<{ permit_type: string }>(
        'select permit_type from permit_types where permit_type = $1',
        [submission.permitType],
      );
      if (permitType.rows.length === 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue a "${submission.permitType}" permit.`,
        };
      }

      if (submission.businessId !== null) {
        // Yours, or nothing. Filing against someone else's business would put
        // their registered name and address on your application.
        const owned = await tx.query(
          `select 1 from businesses where id = $1 and owner_applicant_id = $2`,
          [submission.businessId, applicantId],
        );
        if (owned.rows.length === 0) {
          return {
            ok: false, reason: 'business-not-yours',
            detail: 'That business is not registered to this account.',
          };
        }
      }

      if (submission.documentIds.length > 0) {
        // Uploaded by you, and not already attached to another application. The
        // second half matters: without it a document could be pointed at a new
        // filing and disappear from the one an officer is evaluating.
        const mine = await tx.query<{ n: string }>(
          `select count(*) as n from documents
            where id = any($1) and uploaded_by = $2 and application_id is null and deleted_at is null`,
          [[...submission.documentIds], caller.accountId],
        );
        if (Number(mine.rows[0]?.n ?? 0) !== submission.documentIds.length) {
          return {
            ok: false, reason: 'documents-not-yours',
            detail: 'One or more documents are not yours, are already attached to an application, '
              + 'or no longer exist.',
          };
        }
      }

      const now = this.clock();

      // The charter entry in force ON THE FILING DATE, not the latest one. An
      // application is judged against the pledge that was published when it was
      // filed; re-reading the current entry later would move a deadline the
      // applicant was given.
      const charter = await tx.query<{ id: string; classification: string }>(
        `select id, classification from charter_entries
          where permit_type = $1 and effective_from <= $2::date
            and (effective_to is null or effective_to > $2::date)
          order by effective_from desc limit 1`,
        [submission.permitType, now],
      );
      const charterEntry = charter.rows[0] ?? null;

      const referenceNumber = await this.nextReference(tx, now);
      const inserted = await tx.query<{ id: string }>(
        `insert into applications
           (reference_number, applicant_id, business_id, permit_type, application_action,
            location, lifecycle_status, classification, charter_entry_id, submitted_at, created_by)
         values ($1,$2,$3,$4,$5,$6,'Submitted',$7,$8,$9,$10)
         returning id`,
        [
          referenceNumber, applicantId, submission.businessId, submission.permitType,
          submission.applicationAction, submission.location,
          charterEntry?.classification ?? null, charterEntry?.id ?? null, now, caller.accountId,
        ],
      );
      const applicationId = inserted.rows[0]?.id ?? '';

      if (submission.documentIds.length > 0) {
        await tx.query(
          'update documents set application_id = $1 where id = any($2)',
          [applicationId, [...submission.documentIds]],
        );
      }

      await this.audit.append({
        action: 'application.submitted',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        afterState: { referenceNumber, permitType: submission.permitType },
      }, tx);

      const body = { applicationId, referenceNumber };
      await remember(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'application.submit', digest, status: 201, body,
      });

      return { ok: true, ...body, replayed: false };
    });
  }

  /**
   * The reference number an applicant quotes at a counter.
   *
   * From the same atomic counter the permit numbers use (migration 010), for
   * the same reason: two applications sharing a reference is two filings the
   * LGU cannot tell apart, and counting existing rows collides the moment one
   * did not come from the counter.
   */
  private async nextReference(tx: SqlClient, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const sequence = await tx.query<{ last_issued: number }>(
      `insert into document_number_sequences (series, year, last_issued)
       values ('APP', $1, 1)
       on conflict (series, year)
         do update set last_issued = document_number_sequences.last_issued + 1
       returning last_issued`,
      [year],
    );
    return `E-BPCO-${year}-${String(Number(sequence.rows[0]?.last_issued ?? 1)).padStart(6, '0')}`;
  }
}
