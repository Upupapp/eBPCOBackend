import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';

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
 * The portal's catalogue also names a reviewing department per document and an
 * evaluation sequence per permit type. Departments do not exist in this service
 * at all; inventing a vocabulary to satisfy a field would create a list the LGU
 * never asked for and would then have to maintain, which is how the
 * notification catalogue acquired twenty-four invented types. The evaluation
 * sequence belongs to the lifecycle.
 */

export interface RequirementDocument {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
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
      ? await tx.query<{ code: string; label: string; description: string; required: boolean }>(
          `select code, label, description, required from document_requirements
            where permit_type = $1 and application_action is null order by position, code`,
          [permitType],
        )
      : await tx.query<{ code: string; label: string; description: string; required: boolean }>(
          `select code, label, description, required from document_requirements
            where permit_type = $1 and (application_action is null or application_action = $2)
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

    return this.db.transaction(async (tx) => {
      const known = await tx.query('select permit_type from permit_types where permit_type = $1', [permitType]);
      if (known.rows.length === 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue a "${permitType}" permit.`,
        };
      }

      const before = await this.forPermitType(permitType, applicationAction, tx);

      if (applicationAction === undefined) {
        await tx.query(
          'delete from document_requirements where permit_type = $1 and application_action is null',
          [permitType],
        );
      } else {
        await tx.query(
          'delete from document_requirements where permit_type = $1 and application_action = $2',
          [permitType, applicationAction],
        );
      }
      for (const [position, document] of documents.entries()) {
        await tx.query(
          `insert into document_requirements
             (permit_type, code, label, description, required, position, application_action, updated_at, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [permitType, document.code.trim(), document.label.trim(), document.description ?? '',
           document.required, position, applicationAction ?? null, this.clock(), officer.accountId],
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
