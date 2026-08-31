import { SqlClient } from '../persistence/sql-client';

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly fieldName?: string | null;
  readonly priorValue?: string | null;
  readonly newValue?: string | null;
  readonly provenanceId?: string | null;
  readonly detail?: string | null;
}

/**
 * Appends one audit row.
 *
 * Takes the SqlClient it should write through — which in every caller is the
 * TRANSACTION the change itself is being made in, never the pool. That is the
 * whole discipline: the row and the change commit together or neither does, so
 * there is no state in which the site says something no audit row explains, and
 * none in which the trail claims a change that was rolled back.
 */
export async function audit(tx: SqlClient, entry: AuditEntry): Promise<void> {
  await tx.query(
    `insert into audit_log (actor, action, entity_type, entity_id, field_name,
                            prior_value, new_value, provenance_id, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.actor, entry.action, entry.entityType, entry.entityId,
     entry.fieldName ?? null, entry.priorValue ?? null, entry.newValue ?? null,
     entry.provenanceId ?? null, entry.detail ?? null],
  );
}
