import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { ChecklistStage, isChecklistStage } from '../domain/evaluation-stages';

/**
 * The checklist each permit type asks an applicant for.
 *
 * ── Why a snapshot rather than a version pointer ────────────────────────
 *
 * The checklist changes; a filed application must not. Someone who submitted
 * everything asked of them in March cannot become non-compliant in April
 * because the LGU added a document, and an officer looking at an old
 * application needs the list it was actually judged against.
 *
 * The fee schedule solves the same problem with an effective-dated version,
 * because a fee is arithmetic that has to be reproducible and the schedule has
 * to stay resolvable forever. A checklist is a list. Storing the list on the
 * application is simpler than storing a key to a catalogue that then has to be
 * kept immutable to remain readable.
 *
 * ── What is deliberately not here ───────────────────────────────────────
 *
 * Departments. The portal's catalogue names a reviewing department per
 * document; this service does not — it names the evaluation STAGE that checks
 * each document (migration 060), a vocabulary the lifecycle already has. That
 * is what decides which stages an application goes through at all: a stage
 * with no required document on the checklist is skipped (see
 * `stagesForChecklist`).
 */

export interface RequirementDocument {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  /** The evaluation stage that checks it (migration 060). Absent from a caller that predates it: Initial. */
  readonly stage?: ChecklistStage | undefined;
}

export type RequirementsResult =
  | { readonly ok: true; readonly documents: readonly RequirementDocument[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export class RequirementsService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * `applicationAction`, when given, also returns every requirement that
   * applies regardless of action (`application_action is null` — every
   * permit type but Building Permit, unchanged since before 047). Omitted
   * entirely, only the action-independent rows come back — which is empty
   * for Building Permit, since 047 tagged all of its rows with an action:
   * a caller has to say which one it is filing to see its checklist, the
   * same way the wizard already has to know before it can show step 3.
   */
  async forPermitType(
    permitType: string, applicationAction?: string, tx: SqlClient = this.db,
  ): Promise<readonly RequirementDocument[]> {
    const result = applicationAction === undefined
      ? await tx.query<{ code: string; label: string; description: string; required: boolean; stage: ChecklistStage }>(
          `select code, label, description, required, stage from document_requirements
            where permit_type = $1 and application_action is null and archived_at is null
            order by position, code`,
          [permitType],
        )
      : await tx.query<{ code: string; label: string; description: string; required: boolean; stage: ChecklistStage }>(
          `select code, label, description, required, stage from document_requirements
            where permit_type = $1 and (application_action is null or application_action = $2)
              and archived_at is null
            order by position, code`,
          [permitType, applicationAction],
        );
    return result.rows;
  }

  /**
   * Replaces the whole checklist for one permit type (and, for Building
   * Permit, one application action — the other two actions' rows are left
   * untouched; see the partial-unique-index design in 047).
   *
   * Wholesale, not per-document. An LGU revising a checklist is publishing a
   * list, and a diff API would let a client drop one document by forgetting to
   * mention it — the same reason `save` replaces an account's roles rather than
   * merging them.
   */
  async replace(options: {
    permitType: string; applicationAction?: string; documents: readonly RequirementDocument[]; officer: Caller;
  }): Promise<RequirementsResult> {
    const { permitType, applicationAction, documents, officer } = options;

    const codes = documents.map((document) => document.code.trim());
    const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
    if (duplicates.length > 0) {
      // The primary key would refuse it, but as a constraint violation three
      // frames from the cause. A code is what survives a rename, so two
      // documents sharing one is a checklist that cannot be edited afterwards.
      return {
        ok: false, reason: 'duplicate-code',
        detail: `Two documents share the code "${duplicates[0]}". Codes identify a requirement across `
          + 'renames, so they have to be distinct.',
      };
    }

    const badStage = documents.find((document) => document.stage !== undefined && !isChecklistStage(document.stage));
    if (badStage !== undefined) {
      return {
        ok: false, reason: 'unknown-stage',
        detail: `"${badStage.label}" names the stage "${String(badStage.stage)}". A document is checked at `
          + 'Initial, Zoning, Fire Safety or OBO.',
      };
    }

    return this.db.transaction(async (tx) => {
      const known = await tx.query('select permit_type from permit_types where permit_type = $1', [permitType]);
      if (known.rows.length === 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue a "${permitType}" permit.`,
        };
      }

      const before = await this.forPermitType(permitType, applicationAction, tx);

      // Archive, never delete (2026-09-29): a document the new list leaves out
      // is set aside, visible in the Archive and restorable there; one saved
      // back in under the same code comes back as the same row.
      const now = this.clock();
      const action = applicationAction ?? null;
      await tx.query(
        `update document_requirements set archived_at = $4, archived_by = $5, updated_at = $4, updated_by = $5
          where permit_type = $1 and application_action is not distinct from $2::text
            and archived_at is null and not (code = any($3::text[]))`,
        [permitType, action, documents.map((document) => document.code.trim()), now, officer.accountId],
      );
      for (const [position, document] of documents.entries()) {
        const values = [permitType, document.code.trim(), document.label.trim(), document.description ?? '',
          document.required, position, action, now, officer.accountId, document.stage ?? 'Initial'];
        const kept = await tx.query(
          `update document_requirements
              set label = $3, description = $4, required = $5, position = $6, updated_at = $8, updated_by = $9,
                  stage = $10, archived_at = null, archived_by = null
            where permit_type = $1 and code = $2 and application_action is not distinct from $7::text
            returning id`,
          values,
        );
        if (kept.rows.length > 0) continue;
        await tx.query(
          `insert into document_requirements
             (permit_type, code, label, description, required, position, application_action, updated_at, updated_by, stage)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          values,
        );
      }

      await this.audit.append({
        action: 'requirements.replaced',
        subjectType: 'application',
        subjectId: null,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        actorRole: officer.kind,
        beforeState: { permitType, applicationAction: applicationAction ?? null, documents: before },
        afterState: { permitType, applicationAction: applicationAction ?? null, documents },
      }, tx);

      return { ok: true, documents: await this.forPermitType(permitType, applicationAction, tx) };
    });
  }
}
