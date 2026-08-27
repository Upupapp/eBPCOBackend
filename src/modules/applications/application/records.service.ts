import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { LifecycleStatus, isTerminal } from '../domain/lifecycle';

/**
 * Correcting and putting away a filed application.
 *
 * Both are RECORDS acts, which is a different thing from a lifecycle act, and
 * the difference decides everything below.
 *
 * ── Editing ─────────────────────────────────────────────────────────────
 *
 * An application is a document the LGU received. Editing one is legitimate —
 * a clerk mistypes a street, an applicant corrects a spelling at the counter —
 * and it is also how a record quietly stops matching what was filed. So every
 * change carries a before and an after into the audit chain, and the editable
 * set is a NAMED LIST rather than "whatever the client sends".
 *
 * The portal's own store offers `Partial<Omit<ApplicationRecord, 'id'>>`, which
 * would let a client set `lifecycleStatus` directly and route around the
 * transition table entirely. That is the API this deliberately does not expose.
 *
 * ── What freezes, and when ──────────────────────────────────────────────
 *
 * `permitType` is what the fee schedule is keyed on and what the Citizen's
 * Charter entry was selected by. Once an order of payment has been issued, the
 * applicant has been told a number computed from it; changing it afterwards
 * makes the assessment describe an application that no longer exists. Same for
 * `applicationAction` and the business the permit is for.
 *
 * Once a permit has been generated, nothing is editable at all: the particulars
 * are printed on an instrument the applicant is holding.
 *
 * `location` and `form` stay correctable throughout, because a typo in an
 * address changes no computation — and refusing to fix one would push officers
 * toward cancelling and refiling, which loses the history.
 */

export interface EditableFields {
  readonly location?: string | null;
  readonly permitType?: string;
  readonly applicationAction?: 'New' | 'Renewal' | 'Amendment';
  readonly businessId?: string | null;
  readonly form?: Record<string, unknown>;
}

/** The fields an order of payment freezes, because it was computed from them. */
const FROZEN_BY_ASSESSMENT: readonly (keyof EditableFields)[] = [
  'permitType', 'applicationAction', 'businessId',
];

const COLUMN_OF: Readonly<Record<keyof EditableFields, string>> = {
  location: 'location',
  permitType: 'permit_type',
  applicationAction: 'application_action',
  businessId: 'business_id',
  form: 'form',
};

export type RecordsResult =
  | { readonly ok: true; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export type ArchiveResult =
  | { readonly ok: true; readonly archived: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

interface StateRow {
  id: string;
  lifecycle_status: LifecycleStatus;
  archived_at: Date | null;
  has_order_of_payment: boolean;
  has_permit: boolean;
  location: string | null;
  permit_type: string;
  application_action: string;
  business_id: string | null;
  form: Record<string, unknown> | null;
  applicant_id: string;
}

const STATE = `
  select a.id, a.lifecycle_status, a.archived_at, a.location, a.permit_type,
         a.application_action, a.business_id, a.form, a.applicant_id,
         exists (select 1 from orders_of_payment o where o.application_id = a.id) as has_order_of_payment,
         exists (select 1 from generated_permits p where p.application_id = a.id) as has_permit
    from applications a
   where a.id = $1
   for update
`;

export class RecordsService {
  private readonly audit: AuditService;

  // Constructed rather than injected, as `LifecycleService` and
  // `EvaluationService` already do here: `ApplicationsModule` does not import
  // `ComplianceModule`, and importing it in order to reach one collaborator
  // would couple the two modules for the length of an audit call.
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async edit(options: {
    applicationId: string; patch: EditableFields; caller: Caller;
  }): Promise<RecordsResult> {
    const { applicationId, patch, caller } = options;
    if (!/^[0-9a-fA-F-]{36}$/.test(applicationId)) {
      return { ok: false, reason: 'not-found', detail: 'No such application.' };
    }
    const requested = (Object.keys(patch) as (keyof EditableFields)[])
      .filter((field) => patch[field] !== undefined);
    if (requested.length === 0) {
      return { ok: false, reason: 'empty-patch', detail: 'No editable field was given.' };
    }

    return this.db.transaction(async (tx) => {
      const found = await tx.query<StateRow>(STATE, [applicationId]);
      const before = found.rows[0];
      if (before === undefined) {
        return { ok: false, reason: 'not-found', detail: 'No such application.' };
      }

      if (before.has_permit) {
        return {
          ok: false, reason: 'permit-generated',
          detail: 'A permit has been generated from this application. Its particulars are printed on '
            + 'an instrument the applicant holds, so they can no longer be edited.',
        };
      }
      if (isTerminal(before.lifecycle_status)) {
        return {
          ok: false, reason: 'terminal',
          detail: `This application is ${before.lifecycle_status} and is no longer being processed.`,
        };
      }

      if (before.has_order_of_payment) {
        const frozen = requested.filter((field) => FROZEN_BY_ASSESSMENT.includes(field));
        if (frozen.length > 0) {
          return {
            ok: false, reason: 'assessed',
            detail: `An order of payment has been issued from this application, so ${frozen.join(', ')} `
              + 'can no longer change: the applicant has been given a fee computed from them. '
              + 'Supersede the assessment instead.',
          };
        }
      }

      if (patch.businessId !== undefined && patch.businessId !== null) {
        // Theirs, or nothing — the same rule filing enforces. Pointing an
        // application at another applicant's business would put their
        // registered name and address on this permit.
        const owned = await tx.query(
          'select 1 from businesses where id = $1 and owner_applicant_id = $2',
          [patch.businessId, before.applicant_id],
        );
        if (owned.rows.length === 0) {
          return {
            ok: false, reason: 'business-not-theirs',
            detail: 'That business is not registered to this applicant.',
          };
        }
      }

      if (patch.permitType !== undefined) {
        const known = await tx.query(
          'select permit_type from permit_types where permit_type = $1', [patch.permitType],
        );
        if (known.rows.length === 0) {
          return {
            ok: false, reason: 'unknown-permit-type',
            detail: `The LGU does not issue a "${patch.permitType}" permit.`,
          };
        }
      }

      // Only what actually differs. A patch that resends the current value is
      // not a change, and recording it would fill the audit chain with entries
      // that say nothing happened — which is how a trail stops being read.
      const currentOf: Record<keyof EditableFields, unknown> = {
        location: before.location,
        permitType: before.permit_type,
        applicationAction: before.application_action,
        businessId: before.business_id,
        form: before.form,
      };
      const changes = requested.filter(
        (field) => JSON.stringify(patch[field]) !== JSON.stringify(currentOf[field]),
      );
      if (changes.length === 0) {
        return { ok: true, changed: [] };
      }

      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const field of changes) {
        values.push(field === 'form' ? JSON.stringify(patch.form) : patch[field]);
        assignments.push(`${COLUMN_OF[field]} = $${values.length}`);
      }
      values.push(this.clock(), caller.accountId, applicationId);
      await tx.query(
        `update applications set ${assignments.join(', ')},
            updated_at = $${values.length - 2}, updated_by = $${values.length - 1}
          where id = $${values.length}`,
        values,
      );

      await this.audit.append({
        action: 'application.edited',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: caller.kind,
        beforeState: Object.fromEntries(changes.map((field) => [field, currentOf[field]])),
        afterState: Object.fromEntries(changes.map((field) => [field, patch[field]])),
      }, tx);

      return { ok: true, changed: changes };
    });
  }

  /**
   * Takes finished applications out of the working queue.
   *
   * Bulk, because that is how a queue is tidied, and all-or-nothing: a partial
   * archive leaves an officer guessing which of the twenty they selected are
   * still listed.
   */
  async archive(options: {
    applicationIds: readonly string[]; remarks: string; caller: Caller;
  }): Promise<ArchiveResult> {
    const { applicationIds, remarks, caller } = options;

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{ id: string; lifecycle_status: LifecycleStatus; archived_at: Date | null }>(
        `select id, lifecycle_status, archived_at from applications
          where id = any($1) for update`,
        [[...applicationIds]],
      );

      if (found.rows.length !== applicationIds.length) {
        return {
          ok: false, reason: 'not-found',
          detail: 'One or more of those applications does not exist.',
        };
      }

      const live = found.rows.filter((row) => !isTerminal(row.lifecycle_status));
      if (live.length > 0) {
        // The rule this exists for. An archived in-flight application vanishes
        // from every officer's queue while still owing an act, and the applicant
        // waits on a permit nobody can see. Cancelling is the lifecycle act that
        // ends an application; this is not a way to reach it.
        return {
          ok: false, reason: 'not-terminal',
          detail: `${live.length} of those applications ${live.length === 1 ? 'is' : 'are'} still being `
            + 'processed. Only a Completed, Rejected, Cancelled or Expired application can be archived.',
        };
      }

      const already = found.rows.filter((row) => row.archived_at !== null).map((row) => row.id);
      const toArchive = found.rows.filter((row) => row.archived_at === null).map((row) => row.id);
      if (toArchive.length === 0) return { ok: true, archived: [] };

      const now = this.clock();
      await tx.query(
        `update applications set archived_at = $1, archived_by = $2, archive_remarks = $3,
            updated_at = $1, updated_by = $2
          where id = any($4)`,
        [now, caller.accountId, remarks, toArchive],
      );

      // One entry per application, not one for the batch. The audit chain
      // answers questions about a subject, and a single entry listing twenty
      // ids answers none of them without a text search.
      for (const id of toArchive) {
        await this.audit.append({
          action: 'application.archived',
          subjectType: 'application',
          subjectId: id,
          outcome: 'allowed',
          actorAccountId: caller.accountId,
          actorRole: caller.kind,
          afterState: { remarks, batchSize: toArchive.length, alreadyArchived: already.length },
        }, tx);
      }

      return { ok: true, archived: toArchive };
    });
  }
}
