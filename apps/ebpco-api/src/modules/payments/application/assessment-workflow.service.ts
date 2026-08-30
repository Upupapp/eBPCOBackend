import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { FEE_LINES, FeeLine } from '../domain/order-of-payment';
import { amountsFor, scheduleInForce } from '../domain/fee-schedule';
import { FeeSchedule } from '../domain/fee-schedule';

/**
 * The assessment an officer builds, before the Order of Payment it becomes.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * `issue()` used to do the whole thing: read the published schedule, compute
 * six figures, write an Order. One officer, one act, no second signature. That
 * is the control weakness the portal's four-step workflow exists to close, and
 * it is the same weakness this codebase already refuses elsewhere — an
 * evaluator may not evaluate their own application, and the officer who records
 * a payment may not confirm it.
 *
 * So: a draft is opened, pre-filled from the schedule in force; its lines are
 * adjusted; it is submitted; and a DIFFERENT officer approves it. Only then can
 * an Order be issued.
 *
 * ── The schedule is captured, not re-read ───────────────────────────────
 *
 * The version in force when the draft is opened is written onto it. A schedule
 * that changes mid-draft must not silently move figures an officer has already
 * reviewed — and a historical assessment has to stay explainable against the
 * schedule it was computed under, which is what the column has always been for.
 *
 * ── An override is recorded as an override ──────────────────────────────
 *
 * Each line keeps what the schedule said beside what the officer set. "The
 * officer charged less than the ordinance prescribes" is a question an auditor
 * will eventually ask, and it cannot be answered from the final figure.
 */

export type AssessmentStatus = 'Draft' | 'Submitted' | 'Approved' | 'Issued' | 'Withdrawn';

export interface AssessmentLine {
  readonly line: FeeLine;
  readonly computedCentavos: number;
  readonly amountCentavos: number;
  readonly basis: string;
  readonly included: boolean;
}

export interface Assessment {
  readonly id: string;
  readonly applicationId: string;
  readonly status: AssessmentStatus;
  readonly feeScheduleVersion: string;
  readonly dueDate: string | null;
  readonly lines: readonly AssessmentLine[];
  readonly totalCentavos: number;
  readonly createdBy: string;
  readonly submittedBy: string | null;
  readonly approvedBy: string | null;
}

export type WorkflowResult =
  | { readonly ok: true; readonly assessment: Assessment }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const OPEN: readonly AssessmentStatus[] = ['Draft', 'Submitted', 'Approved'];

export class AssessmentWorkflowService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly schedules: () => Promise<FeeSchedule[]> = () => Promise.resolve([]),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  private async load(tx: SqlClient, id: string): Promise<Assessment | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    const head = await tx.query<{
      id: string; application_id: string; status: AssessmentStatus; fee_schedule_version: string;
      due_date: string | null; created_by: string; submitted_by: string | null; approved_by: string | null;
    }>(
      `select id, application_id, status, fee_schedule_version,
              to_char(due_date, 'YYYY-MM-DD') as due_date,
              created_by, submitted_by, approved_by
         from assessments where id = $1`,
      [id],
    );
    const row = head.rows[0];
    if (row === undefined) return null;

    const lines = await tx.query<{
      line: FeeLine; computed_centavos: string; amount_centavos: string; basis: string; included: boolean;
    }>(
      'select line, computed_centavos, amount_centavos, basis, included from assessment_lines where assessment_id = $1',
      [id],
    );
    // Ordered by the canonical list rather than by the database. The six lines
    // are a fixed breakdown an applicant reads top to bottom; `order by line`
    // would put them in alphabetical order, which is not an order anyone means.
    const byLine = new Map(lines.rows.map((row) => [row.line, row]));
    const shaped = FEE_LINES.map((line) => {
      const found = byLine.get(line);
      return {
        line,
        computedCentavos: Number(found?.computed_centavos ?? 0),
        amountCentavos: Number(found?.amount_centavos ?? 0),
        basis: found?.basis ?? '',
        included: found?.included ?? true,
      };
    });

    return {
      id: row.id,
      applicationId: row.application_id,
      status: row.status,
      feeScheduleVersion: row.fee_schedule_version,
      dueDate: row.due_date,
      lines: shaped,
      totalCentavos: shaped
        .filter((line) => line.included)
        .reduce((running, line) => running + line.amountCentavos, 0),
      createdBy: row.created_by,
      submittedBy: row.submitted_by,
      approvedBy: row.approved_by,
    };
  }

  /** Opens a draft, pre-filled from the schedule in force today. */
  async draft(options: {
    applicationId: string; officer: Caller; dueDate?: string; revision?: boolean;
  }): Promise<WorkflowResult> {
    const { applicationId, officer } = options;

    // Read BEFORE the transaction opens, and not merely as an optimisation.
    // `schedules()` queries the outer client, and PGlite is a single
    // connection — issuing that query while a transaction is open on the same
    // connection blocks until the request times out. It surfaced as a 503 on
    // every draft, twenty seconds at a time, which is a deadlock wearing a
    // slow-endpoint costume.
    //
    // It also belongs outside on its own merits: the published schedule is
    // effective-dated reference data, not part of the write being made atomic.
    const schedule = scheduleInForce(await this.schedules(), isoDate(this.clock()));

    return this.db.transaction(async (tx) => {
      const application = await tx.query<{ permit_type: string }>(
        'select permit_type from applications where id = $1', [applicationId],
      );
      const permitType = application.rows[0]?.permit_type;
      if (permitType === undefined) {
        return { ok: false, reason: 'not-found', detail: 'No such application.' };
      }

      const open = await tx.query<{ id: string; status: string }>(
        'select id, status from assessments where application_id = $1 and status = any($2)',
        [applicationId, [...OPEN]],
      );
      if (open.rows.length > 0) {
        // The unique index refuses it anyway; refusing here means the officer
        // is told which assessment is already open rather than meeting a
        // constraint violation as a 500.
        return {
          ok: false, reason: 'already-open',
          detail: `An assessment for this application is already ${open.rows[0]?.status}. `
            + 'Withdraw it before starting another.',
        };
      }

      const issued = await tx.query(
        'select id from orders_of_payment where application_id = $1 and superseded_at is null',
        [applicationId],
      );
      if (issued.rows.length > 0 && options.revision !== true) {
        return {
          ok: false, reason: 'already-assessed',
          detail: 'An Order of Payment is already in force. Draft a revision if it needs correcting.',
        };
      }
      if (issued.rows.length === 0 && options.revision === true) {
        // Asked for explicitly, and refused when there is nothing to revise.
        // A revision that silently became a first assessment would skip the
        // reason an applicant is owed for a bill that changed.
        return {
          ok: false, reason: 'nothing-to-revise',
          detail: 'No Order of Payment is in force for this application, so there is nothing to revise.',
        };
      }

      if (schedule === null) {
        // M-08. Opening a draft with no schedule would mean six figures with no
        // authority behind them, which is the case `buildLineItems` refuses at
        // issue time — better to refuse before an officer has typed anything.
        return {
          ok: false, reason: 'no-schedule',
          detail: 'No LGU fee schedule is in force on this date, so nothing can be assessed.',
        };
      }

      let computed: { amounts: Partial<Record<FeeLine, number>>; bases: Partial<Record<FeeLine, string>> };
      try {
        computed = amountsFor(schedule, permitType);
      } catch {
        return {
          ok: false, reason: 'no-schedule',
          detail: `The schedule in force does not cover "${permitType}".`,
        };
      }

      const inserted = await tx.query<{ id: string }>(
        `insert into assessments (application_id, fee_schedule_version, due_date, created_by, created_at)
         values ($1,$2,$3,$4,$5) returning id`,
        [applicationId, schedule.version, options.dueDate ?? null, officer.accountId, this.clock()],
      );
      const id = inserted.rows[0]?.id ?? '';

      for (const line of FEE_LINES) {
        const amount = computed.amounts[line] ?? 0;
        await tx.query(
          `insert into assessment_lines (assessment_id, line, computed_centavos, amount_centavos, basis)
           values ($1,$2,$3,$3,$4)`,
          [id, line, amount, computed.bases[line]?.trim() ?? ''],
        );
      }

      await this.audit.append({
        action: 'assessment.drafted',
        subjectType: 'order-of-payment',
        subjectId: id,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        afterState: { applicationId, feeScheduleVersion: schedule.version },
      }, tx);

      const assessment = await this.load(tx, id);
      return assessment === null
        ? { ok: false, reason: 'not-found', detail: 'The draft vanished after creation.' }
        : { ok: true, assessment };
    });
  }

  /** Sets one line's amount, whether it is charged, and what it rests on. */
  async setLine(options: {
    assessmentId: string; line: FeeLine; officer: Caller;
    amountCentavos?: number; included?: boolean; basis?: string;
  }): Promise<WorkflowResult> {
    const { assessmentId, line, officer } = options;

    return this.db.transaction(async (tx) => {
      const before = await this.load(tx, assessmentId);
      if (before === null) return { ok: false, reason: 'not-found', detail: 'No such assessment.' };
      if (before.status !== 'Draft') {
        return {
          ok: false, reason: 'not-draft',
          detail: `This assessment is ${before.status}. Only a Draft can be edited.`,
        };
      }

      const current = before.lines.find((existing) => existing.line === line)!;
      const amount = options.amountCentavos ?? current.amountCentavos;
      const included = options.included ?? current.included;
      const basis = options.basis ?? current.basis;

      if (included && amount > 0 && basis.trim() === '') {
        // The rule `buildLineItems` enforces at issue time, applied where the
        // officer can still do something about it. A non-zero charge with no
        // stated authority is a figure the applicant cannot question, and RA
        // 11032's transparency requirement is not satisfied by a total.
        return {
          ok: false, reason: 'no-basis',
          detail: `The ${line} fee is charged but names no ordinance or issuance it rests on.`,
        };
      }

      await tx.query(
        `update assessment_lines set amount_centavos = $1, included = $2, basis = $3
          where assessment_id = $4 and line = $5`,
        [amount, included, basis, assessmentId, line],
      );
      await tx.query('update assessments set updated_at = $1 where id = $2', [this.clock(), assessmentId]);

      if (amount !== current.amountCentavos || included !== current.included || basis !== current.basis) {
        await this.audit.append({
          action: 'assessment.line-changed',
          subjectType: 'order-of-payment',
          subjectId: assessmentId,
          outcome: 'allowed',
          actorAccountId: officer.accountId,
          beforeState: { ...current },
          afterState: {
            line, amountCentavos: amount, included, basis,
            computedCentavos: current.computedCentavos,
            // Named explicitly rather than left to be derived later. An
            // override is the fact an auditor is looking for.
            overridesSchedule: amount !== current.computedCentavos,
          },
        }, tx);
      }

      const assessment = await this.load(tx, assessmentId);
      return { ok: true, assessment: assessment! };
    });
  }

  async submit(options: { assessmentId: string; officer: Caller }): Promise<WorkflowResult> {
    return this.db.transaction(async (tx) => {
      const before = await this.load(tx, options.assessmentId);
      if (before === null) return { ok: false, reason: 'not-found', detail: 'No such assessment.' };
      if (before.status !== 'Draft') {
        return {
          ok: false, reason: 'not-draft',
          detail: `This assessment is ${before.status} and cannot be submitted again.`,
        };
      }
      if (before.totalCentavos <= 0) {
        return {
          ok: false, reason: 'nothing-to-charge',
          detail: 'Every line is zero or excluded, so there is nothing to approve.',
        };
      }

      await tx.query(
        'update assessments set status = $1, submitted_by = $2, submitted_at = $3, updated_at = $3 where id = $4',
        ['Submitted', options.officer.accountId, this.clock(), options.assessmentId],
      );
      await this.audit.append({
        action: 'assessment.submitted',
        subjectType: 'order-of-payment',
        subjectId: options.assessmentId,
        outcome: 'allowed',
        actorAccountId: options.officer.accountId,
        afterState: { totalCentavos: before.totalCentavos },
      }, tx);

      return { ok: true, assessment: (await this.load(tx, options.assessmentId))! };
    });
  }

  /**
   * A SECOND officer approves. The whole point of the workflow.
   *
   * Refused for the assessor and for whoever submitted it, which are usually
   * the same person and are checked separately because they need not be. The
   * database refuses it too — a bug that has to defeat a constraint is a much
   * harder bug to write than one that has to defeat an `if`.
   */
  async approve(options: { assessmentId: string; officer: Caller }): Promise<WorkflowResult> {
    return this.db.transaction(async (tx) => {
      const before = await this.load(tx, options.assessmentId);
      if (before === null) return { ok: false, reason: 'not-found', detail: 'No such assessment.' };
      if (before.status !== 'Submitted') {
        return {
          ok: false, reason: 'not-submitted',
          detail: `This assessment is ${before.status}. Only a Submitted assessment can be approved.`,
        };
      }
      if (options.officer.accountId === before.createdBy || options.officer.accountId === before.submittedBy) {
        return {
          ok: false, reason: 'self-approval',
          detail: 'An officer may not approve an assessment they prepared or submitted. '
            + 'Ask another officer to review it.',
        };
      }

      await tx.query(
        'update assessments set status = $1, approved_by = $2, approved_at = $3, updated_at = $3 where id = $4',
        ['Approved', options.officer.accountId, this.clock(), options.assessmentId],
      );
      await this.audit.append({
        action: 'assessment.approved',
        subjectType: 'order-of-payment',
        subjectId: options.assessmentId,
        outcome: 'allowed',
        actorAccountId: options.officer.accountId,
        beforeState: { preparedBy: before.createdBy, submittedBy: before.submittedBy },
        afterState: { totalCentavos: before.totalCentavos },
      }, tx);

      return { ok: true, assessment: (await this.load(tx, options.assessmentId))! };
    });
  }

  /** The approved assessment an Order may be issued from, if there is one. */
  async approvedFor(applicationId: string, tx: SqlClient = this.db): Promise<Assessment | null> {
    const found = await tx.query<{ id: string }>(
      "select id from assessments where application_id = $1 and status = 'Approved'",
      [applicationId],
    );
    const id = found.rows[0]?.id;
    return id === undefined ? null : this.load(tx, id);
  }

  async markIssued(assessmentId: string, orderId: string, tx: SqlClient): Promise<void> {
    await tx.query(
      "update assessments set status = 'Issued', order_of_payment_id = $1, updated_at = $2 where id = $3",
      [orderId, this.clock(), assessmentId],
    );
  }

  async byId(id: string): Promise<Assessment | null> {
    return this.load(this.db, id);
  }
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
