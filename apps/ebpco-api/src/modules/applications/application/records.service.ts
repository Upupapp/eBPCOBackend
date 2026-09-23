import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { LifecycleStatus, isTerminal } from '../domain/lifecycle';
import { RequirementsService } from './requirements.service';
import { resolveRenewal } from './resolve-renewal';

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
  /**
   * Which permit this Renewal/Amendment is about — see `Submission.
   * renewsPermitNumber`/`priorPermitClaim` (submission.service.ts) for what
   * each means; the resolution rule is the exact same `resolveRenewal()`
   * both go through.
   *
   * Resent TOGETHER with `applicationAction`, always — the admin intake
   * form holds all three in its own state the same way the citizen wizard
   * does (see `SubmissionService.updateDraft()`'s identical convention), so
   * `applicationAction` present is read as "the whole reference triad is
   * being resent", not a sparse field. Sending either of these two without
   * `applicationAction` is refused rather than silently ignored.
   */
  readonly renewsPermitNumber?: string | null;
  readonly priorPermitClaim?: string | null;
}

/** The fields an order of payment freezes, because it was computed from them. */
const FROZEN_BY_ASSESSMENT: readonly (keyof EditableFields)[] = [
  'permitType', 'applicationAction', 'businessId',
];

/**
 * The plain, direct-pass-through fields — everything `EditableFields` has
 * EXCEPT the renewal reference, which is deliberately not here: the column
 * it writes (`renews_permit_id`, an application id) is not the value the
 * patch carries (`renewsPermitNumber`, a permit number quoted by the
 * applicant), so it cannot go through a value-in-column-out map the way
 * these can. It is resolved and written by its own dedicated block below.
 */
type PlainField = Exclude<keyof EditableFields, 'renewsPermitNumber' | 'priorPermitClaim'>;

const COLUMN_OF: Readonly<Record<PlainField, string>> = {
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
  renews_permit_id: string | null;
  prior_permit_claim: string | null;
}

const STATE = `
  select a.id, a.lifecycle_status, a.archived_at, a.location, a.permit_type,
         a.application_action, a.business_id, a.form, a.applicant_id,
         a.renews_permit_id, a.prior_permit_claim,
         exists (select 1 from orders_of_payment o where o.application_id = a.id) as has_order_of_payment,
         exists (select 1 from generated_permits p where p.application_id = a.id) as has_permit
    from applications a
   where a.id = $1
   for update
`;

export class RecordsService {
  private readonly audit: AuditService;

  private readonly requirements: RequirementsService;

  // Constructed rather than injected, as `LifecycleService` and
  // `EvaluationService` already do here: `ApplicationsModule` does not import
  // `ComplianceModule`, and importing it in order to reach one collaborator
  // would couple the two modules for the length of an audit call.
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
    requirements?: RequirementsService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
    this.requirements = requirements ?? new RequirementsService(db, clock, this.audit);
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

      // See EditableFields.renewsPermitNumber's own comment: either of these
      // two without applicationAction is a client bug, not a sparse patch —
      // resend the whole triad or none of it.
      if ((patch.renewsPermitNumber !== undefined || patch.priorPermitClaim !== undefined)
        && patch.applicationAction === undefined) {
        return {
          ok: false, reason: 'renewal-reference-incomplete',
          detail: 'Changing which permit this renews/amends requires resending applicationAction alongside it.',
        };
      }

      const nextAction = patch.applicationAction ?? before.application_action;

      // Only what actually differs. A patch that resends the current value is
      // not a change, and recording it would fill the audit chain with entries
      // that say nothing happened — which is how a trail stops being read.
      const currentOf: Record<PlainField, unknown> = {
        location: before.location,
        permitType: before.permit_type,
        applicationAction: before.application_action,
        businessId: before.business_id,
        form: before.form,
      };
      const plainFields = requested.filter(
        (field): field is PlainField => field !== 'renewsPermitNumber' && field !== 'priorPermitClaim',
      );
      const changes = plainFields.filter(
        (field) => JSON.stringify(patch[field]) !== JSON.stringify(currentOf[field]),
      );

      // Resolved the same way a fresh filing resolves it — see
      // resolveRenewal()'s own doc comment. `tolerateNoReferenceYet` only
      // for a Draft: a FILED Renewal/Amendment must still name what it
      // renews, the same rule submit() enforces: a correction may not
      // un-name it.
      let renewsPermitId: string | null | undefined;
      let priorPermitClaim: string | null | undefined;
      if (patch.applicationAction !== undefined) {
        const renewal = await resolveRenewal(tx, {
          action: nextAction,
          permitNumber: patch.renewsPermitNumber ?? null,
          priorPermitClaim: patch.priorPermitClaim ?? null,
          applicantId: before.applicant_id,
          tolerateNoReferenceYet: before.lifecycle_status === 'Draft',
        });
        if (!renewal.ok) return { ok: false, reason: renewal.reason, detail: renewal.detail };
        renewsPermitId = renewal.permitId;
        priorPermitClaim = renewal.priorPermitClaim;
      }
      const renewalChanged = renewsPermitId !== undefined
        && (renewsPermitId !== before.renews_permit_id || priorPermitClaim !== before.prior_permit_claim);

      if (changes.length === 0 && !renewalChanged) {
        return { ok: true, changed: [] };
      }

      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const field of changes) {
        values.push(field === 'form' ? JSON.stringify(patch.form) : patch[field]);
        assignments.push(`${COLUMN_OF[field]} = $${values.length}`);
      }
      if (renewalChanged) {
        values.push(renewsPermitId);
        assignments.push(`renews_permit_id = $${values.length}`);
        values.push(priorPermitClaim);
        assignments.push(`prior_permit_claim = $${values.length}`);
      }
      // Re-snapshotted alongside a Draft's own permitType/action edit only —
      // unlike a filed application's checklist, frozen forever (see this
      // class's own doc comment on why), a Draft has not been judged
      // against anything yet, so its checklist should track what it
      // currently says it's for. Same reasoning as
      // SubmissionService.updateDraft().
      if (before.lifecycle_status === 'Draft'
        && (patch.permitType !== undefined || patch.applicationAction !== undefined)) {
        const nextPermitType = patch.permitType ?? before.permit_type;
        const requiredDocuments = await this.requirements.forPermitType(nextPermitType, nextAction, tx);
        values.push(JSON.stringify(requiredDocuments));
        assignments.push(`required_documents = $${values.length}`);
      }

      values.push(this.clock(), caller.accountId, applicationId);
      await tx.query(
        `update applications set ${assignments.join(', ')},
            updated_at = $${values.length - 2}, updated_by = $${values.length - 1}
          where id = $${values.length}`,
        values,
      );

      const changed: string[] = [...changes];
      const beforeState: Record<string, unknown> = Object.fromEntries(changes.map((field) => [field, currentOf[field]]));
      const afterState: Record<string, unknown> = Object.fromEntries(changes.map((field) => [field, patch[field]]));
      if (renewalChanged) {
        changed.push('renewsPermitNumber', 'priorPermitClaim');
        beforeState.renewsPermitId = before.renews_permit_id;
        beforeState.priorPermitClaim = before.prior_permit_claim;
        afterState.renewsPermitId = renewsPermitId;
        afterState.priorPermitClaim = priorPermitClaim;
      }

      await this.audit.append({
        action: 'application.edited',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: caller.kind,
        beforeState,
        afterState,
      }, tx);

      return { ok: true, changed };
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
