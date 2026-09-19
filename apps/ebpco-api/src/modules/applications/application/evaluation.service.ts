import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { deepLinkFor, entryFor } from '../../notifications/domain/catalog';
import { Caller } from '../domain/application';
import { visibleStatusesFor } from '../domain/visibility';

/**
 * An officer's decision on one stage of an evaluation.
 *
 * Five stages, each decided once. The lifecycle engine asks "are the
 * evaluations complete" before it will let an application be assessed or
 * approved, and this is what makes that question answerable — until now the
 * precondition could only ever be false, because nothing wrote a row.
 *
 * The remarks are the point of the whole record. An applicant told "Revision
 * Required" and nothing else has a deadline they cannot meet, because they do
 * not know what to do. The database refuses an adverse result without them; so
 * does this, earlier and with a message that says which field.
 */

export const EVALUATION_STAGES = ['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'] as const;
export type EvaluationStage = (typeof EVALUATION_STAGES)[number];

export const EVALUATION_RESULTS = ['Passed', 'Revision Required', 'Rejected'] as const;
export type EvaluationResult = (typeof EVALUATION_RESULTS)[number];

export type RecordResult =
  | { readonly ok: true; readonly evaluationId: string; readonly complete: boolean }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'already-decided' | 'remarks-required' | 'self-review' | 'out-of-order';
      readonly detail: string;
    };

/**
 * The order the stages are worked in.
 *
 * Not decoration: Fire Safety examines a plan the OBO has not yet checked
 * structurally, and passing a later stage first produces a record that says an
 * application was cleared on evidence nobody had. The order is the LGU's, taken
 * from the admin's own EVALUATION_STAGE_ORDER, and an out-of-order attempt is
 * refused with the stage that is actually next.
 */
const ORDER: readonly EvaluationStage[] = EVALUATION_STAGES;

export interface EvaluationQueueRow {
  readonly applicationId: string;
  readonly referenceNumber: string;
  readonly permitType: string;
  readonly lifecycleStatus: string;
  readonly applicantName: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly submittedAt: string | null;
  readonly evaluations: ReadonlyArray<{
    id: string; stage: EvaluationStage; result: string; remarks: string | null; evaluatedAt: string | null;
  }>;
  /** The stage this application is waiting on, or null when all six are decided. */
  readonly nextStage: EvaluationStage | null;
  /** Both sides, never the difference — see `queue()` for why. */
  readonly requiredDocumentCount: number;
  readonly attachedDocumentCount: number;
}

/** Same shape as the applications queue's, deliberately: one cursor to learn. */
function encodeQueueCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeQueueCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (at === undefined || id === undefined) return null;
    const updatedAt = new Date(at);
    if (Number.isNaN(updatedAt.getTime())) return null;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export class EvaluationService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * Every recorded stage for one application, in the order they were decided.
   *
   * THE reader. The staff detail view used to run its own near-identical query
   * over the same rows — same table, same filter, a differently spelled ORDER
   * BY — which is two answers to one question, each free to drift when a column
   * is added or a stage is filtered out for a reason that only occurs to
   * whoever is editing one of them. The reachability audit found it: this
   * method had no caller outside its own spec while the view it duplicated was
   * serving officers.
   *
   * `nulls last` is explicit rather than implied. Postgres already orders ASC
   * that way, so this is not a behaviour change — it is stating which end the
   * undecided stages belong at, so that reversing the sort later does not move
   * them silently.
   */
  async of(applicationId: string): Promise<ReadonlyArray<{
    id: string; stage: EvaluationStage; result: string;
    remarks: string | null; evaluatedAt: string | null;
  }>> {
    const result = await this.db.query<{
      id: string; stage: EvaluationStage; result: string;
      remarks: string | null; evaluated_at: Date | null;
    }>(
      `select id, stage, result, remarks, evaluated_at from evaluations
        where application_id = $1 order by evaluated_at nulls last`,
      [applicationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      result: row.result,
      remarks: row.remarks,
      // The driver hands back a Date, which JSON renders in exactly this
      // format; converting here makes the boundary explicit rather than
      // depending on the serialiser to do it.
      evaluatedAt: row.evaluated_at === null ? null : row.evaluated_at.toISOString(),
    }));
  }

  /**
   * The evaluator's worklist: every application evaluation touches, or is about
   * to.
   *
   * Extends the one reader rather than adding a third query. `of()` answers
   * "this application's evaluations" and this answers "which applications", and
   * both read the same rows through the same shapes — the staff detail view
   * already tried holding a second near-identical query and the two were free
   * to drift.
   *
   * ── What it does NOT return, and why ────────────────────────────────────
   *
   * The portal's row shows a MISSING DOCUMENTS count. This service cannot
   * compute one. `documents.label` is free text typed by whoever uploaded the
   * file, and nothing links a document to the requirement it satisfies — there
   * is no `requirement_code` column, so matching would mean guessing on label
   * text and silently mis-reporting whether an applicant has complied.
   *
   * So both sides are returned as counts and the subtraction is not performed.
   * A number that is wrong in the applicant's favour lets an incomplete
   * application through; wrong the other way sends someone back for a document
   * they already brought. Neither is worth a guess.
   *
   * ── And no bucket vocabulary ────────────────────────────────────────────
   *
   * The portal groups these into under-review / returned / passed. That
   * projection is the client's, and computing it here as well would be two
   * definitions of one thing — which is exactly the drift the single reader was
   * collapsed to remove. The facts it derives from are returned instead.
   */
  async queue(
    caller: Caller,
    filters: {
      stage?: EvaluationStage;
      result?: EvaluationResult;
      evaluatedByMe?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ rows: readonly EvaluationQueueRow[]; nextCursor: string | null }> {
    const visible = visibleStatusesFor(caller);
    if (Array.isArray(visible) && visible.length === 0) return { rows: [], nextCursor: null };

    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    const where: string[] = [
      // In evaluation, or already evaluated. The second half is what keeps a
      // passed application visible after it has moved on: an evaluator looking
      // for what they cleared last week is not looking at the live queue.
      `(a.lifecycle_status in ('Document Verification', 'Under Evaluation', 'Revision Required')
        or exists (select 1 from evaluations e where e.application_id = a.id))`,
      'a.archived_at is null',
    ];
    if (visible !== 'all') where.push(`a.lifecycle_status = any(${bind(visible)})`);
    if (filters.result !== undefined) {
      where.push(`exists (select 1 from evaluations e
                           where e.application_id = a.id and e.result = ${bind(filters.result)})`);
    }
    if (filters.evaluatedByMe === true) {
      where.push(`exists (select 1 from evaluations e
                           where e.application_id = a.id and e.evaluator_id = ${bind(caller.accountId)})`);
    }
    if (filters.cursor !== undefined) {
      const decoded = decodeQueueCursor(filters.cursor);
      if (decoded === null) return { rows: [], nextCursor: null };
      where.push(`(a.updated_at, a.id) < (${bind(decoded.updatedAt)}, ${bind(decoded.id)})`);
    }

    const result = await this.db.query<{
      id: string; reference_number: string; permit_type: string; lifecycle_status: string;
      submitted_at: Date | null; updated_at: Date; applicant_name: string;
      business_id: string | null; business_name: string | null;
      required_documents: { code: string; required: boolean }[] | null;
      attached_documents: number;
    }>(
      `select a.id, a.reference_number, a.permit_type, a.lifecycle_status,
              a.submitted_at, a.updated_at,
              ap.first_name || ' ' || ap.last_name as applicant_name,
              a.business_id, b.name as business_name,
              a.required_documents,
              (select count(*)::int from documents d
                where d.application_id = a.id and d.deleted_at is null) as attached_documents
         from applications a
         join applicants ap on ap.id = a.applicant_id
    left join businesses b on b.id = a.business_id
        where ${where.join(' and ')}
     order by a.updated_at desc, a.id desc
        limit ${bind(limit + 1)}`,
      values,
    );

    const page = result.rows.slice(0, limit);
    const rows: EvaluationQueueRow[] = [];
    for (const row of page) {
      const evaluations = await this.of(row.id);
      // Same rule as record()'s own ordering check: a stage only counts as
      // settled once it has PASSED, so an application stuck on an adverse
      // verdict keeps showing that stage as next rather than the queue
      // reporting it as waiting on whatever comes after.
      const passed = new Set(evaluations.filter((evaluation) => evaluation.result === 'Passed').map((evaluation) => evaluation.stage));
      const next = ORDER.find((stage) => !passed.has(stage)) ?? null;
      if (filters.stage !== undefined && next !== filters.stage) continue;

      const required = (row.required_documents ?? []).filter((document) => document.required);
      rows.push({
        applicationId: row.id,
        referenceNumber: row.reference_number,
        permitType: row.permit_type,
        lifecycleStatus: row.lifecycle_status,
        applicantName: row.applicant_name,
        businessId: row.business_id,
        businessName: row.business_name,
        submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
        evaluations,
        nextStage: next,
        requiredDocumentCount: required.length,
        attachedDocumentCount: row.attached_documents,
      });
    }

    const last = page[page.length - 1];
    return {
      rows,
      nextCursor: result.rows.length > limit && last !== undefined
        ? encodeQueueCursor(last.updated_at, last.id)
        : null,
    };
  }

  /**
   * Records one stage's outcome.
   *
   * A PASSED stage is decided once and is never revisited — an evaluation an
   * applicant was shown, silently replaced, is a record that no longer
   * matches what they were told. An ADVERSE stage (Revision Required or
   * Rejected) is not the same kind of decided: the lifecycle sends the
   * applicant back through 'Revision Required' precisely so the deficiency
   * can be fixed and the stage re-decided, and `unique (application_id,
   * stage)` (migration 005) means there is only ever one row to hold that
   * correction in — this upserts onto it rather than inserting a second.
   *
   * Before this, an adverse verdict on ANY stage made `evaluations_complete`
   * permanently false for that application: `record()` refused to touch the
   * row again ("already-decided") no matter how many times the applicant
   * corrected the deficiency and cycled back through 'Revision Required',
   * so the application could never reach Assessed or Approved. The audit
   * trail's own `afterState` on every call already anticipated this ("the
   * entry that survives if the evaluation is ever superseded") — the schema
   * and the audit log were ready for a correction; only this method refused
   * to ever make one.
   */
  async record(options: {
    applicationId: string;
    stage: EvaluationStage;
    result: EvaluationResult;
    evaluator: Caller;
    remarks?: string;
  }): Promise<RecordResult> {
    const { applicationId, stage, result, evaluator, remarks } = options;

    if ((result === 'Revision Required' || result === 'Rejected') && (remarks ?? '').trim().length < 10) {
      return {
        ok: false,
        reason: 'remarks-required',
        detail: 'An adverse result must state what the applicant has to fix, in words they can act on.',
      };
    }

    return this.db.transaction(async (tx) => {
      const application = await tx.query<{ id: string; applicant_account_id: string }>(
        `select a.id, acc.id as applicant_account_id
           from applications a
           join applicants ap on ap.id = a.applicant_id
           join accounts acc on acc.id = ap.account_id
          where a.id = $1 for update`,
        [applicationId],
      );
      const row = application.rows[0];
      if (row === undefined) return { ok: false, reason: 'not-found', detail: 'no such application' };

      // An officer who is also the applicant is not a hypothetical: staff apply
      // for permits on their own houses.
      if (row.applicant_account_id === evaluator.accountId) {
        return {
          ok: false,
          reason: 'self-review',
          detail: 'An officer may not evaluate their own application.',
        };
      }

      const existing = await tx.query<{ stage: EvaluationStage; result: string }>(
        'select stage, result from evaluations where application_id = $1',
        [applicationId],
      );
      const decided = new Map(existing.rows.map((e) => [e.stage, e.result]));

      if (decided.get(stage) === 'Passed') {
        return {
          ok: false,
          reason: 'already-decided',
          detail: `The ${stage} stage has already been decided. Correcting it means a new evaluation cycle.`,
        };
      }

      // A stage only counts as settled, for ordering purposes, once it has
      // PASSED — an adverse verdict still occupies its row (see the doc
      // comment above) but must keep blocking every stage after it until it
      // is corrected, the same as a never-decided stage would.
      const next = ORDER.find((candidate) => decided.get(candidate) !== 'Passed');
      if (next !== stage) {
        return {
          ok: false,
          reason: 'out-of-order',
          detail: `${next ?? 'No stage'} is next for this application, not ${stage}.`,
        };
      }

      const inserted = await tx.query<{ id: string }>(
        `insert into evaluations (application_id, stage, result, evaluator_id, remarks, evaluated_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (application_id, stage) do update
           set result = excluded.result, evaluator_id = excluded.evaluator_id,
               remarks = excluded.remarks, evaluated_at = excluded.evaluated_at
           where evaluations.result <> 'Passed'
         returning id`,
        [applicationId, stage, result, evaluator.accountId, remarks ?? null, this.clock()],
      );

      await this.audit.append({
        action: 'evaluation.recorded',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: evaluator.accountId,
        // The remarks are in the audit trail as well as on the record, because
        // this is the entry that survives if the evaluation is ever superseded.
        afterState: { stage, result, remarks: remarks ?? null },
      }, tx);

      // A passed stage told the applicant nothing. `evaluation-stage-passed` has
      // been in the catalog — with copy, a category and a deep link — since the
      // catalog was reconciled with the client, and nothing ever wrote it: the
      // only writer of notifications was the lifecycle transition table, and an
      // evaluation is not a transition. So an applicant watching their
      // application saw five stages clear in silence.
      //
      // Adverse results are deliberately NOT notified here. They are followed by
      // a move to Revision Required or Rejected, which notifies with the remarks
      // that say what to do; a second notice fired from this point would either
      // duplicate that or, if the officer never makes the move, announce a
      // refusal the application has not actually received.
      //
      // Written in this transaction for the same reason the lifecycle writes its
      // own: a notice for an evaluation that then rolls back is a notice about
      // something that never happened.
      if (result === 'Passed') {
        const entry = entryFor('evaluation-stage-passed');
        if (entry !== undefined) {
          // The catalog's own body, verbatim, was the ONLY thing ever
          // written here on the theory that the deep link would let an
          // applicant tell five of these apart. It doesn't: `deepLinkFor`
          // resolves to the same `/applications/:applicationId` for every
          // stage of the same application, so all five notices for one
          // application end up with identical type, title, body AND deep
          // link — reported live as five indistinguishable "Evaluation
          // stage passed" rows. The `notifications` table has no
          // stage/metadata column to carry this separately (migration
          // 006), so the stage is appended to the catalog's own sentence
          // rather than replacing it — the canonical copy still opens the
          // message, this only adds the one fact it was missing.
          await tx.query(
            `insert into notifications (account_id, type, application_id, title, body, deep_link)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              row.applicant_account_id, entry.type, applicationId,
              entry.title, `${entry.body} Stage: ${stage}.`, deepLinkFor(entry, applicationId),
            ],
          );
        }
      }

      decided.set(stage, result);
      // Every stage decided is not the same as every stage cleared — an
      // adverse result still counts as "decided" for out-of-order checks
      // above, but must not report the evaluation cycle as complete, since
      // that flag is what the lifecycle asks before letting an application
      // move on to Assessed or Approved.
      const complete = ORDER.every((candidate) => decided.get(candidate) === 'Passed');

      return { ok: true, evaluationId: inserted.rows[0]?.id ?? '', complete };
    });
  }
}
