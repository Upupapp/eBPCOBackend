import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  fieldName?: string;
  priorValue?: string;
  newValue?: string;
  detail?: string;
  /** True when a value was withheld at READ time. The row itself is intact. */
  redacted?: boolean;
}

const REDACTED = '[withheld]';

@Injectable()
export class AuditRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * One entity's editorial history, oldest first.
   *
   * Redaction is applied HERE and nowhere else. The stored row keeps the value
   * in full for ever; if the field it concerns is later withheld, the response
   * says `[withheld]` and flags the row. The trail stays complete — it can
   * still answer "was this ever published, and when did it stop" — while the
   * response respects the withdrawal. Blanking at write time would destroy the
   * only record that could answer the question.
   */
  async history(entityType: string, entityId: string): Promise<AuditRow[]> {
    const { rows } = await this.db.query<{
      at: Date; actor: string; action: string; entity_type: string; entity_id: string;
      field_name: string | null; prior_value: string | null; new_value: string | null;
      detail: string | null; state: string | null;
    }>(
      `select a.at, a.actor, a.action, a.entity_type, a.entity_id, a.field_name,
              a.prior_value, a.new_value, a.detail,
              fs.state::text as state
         from audit_log a
         left join field_state fs
                on fs.entity_type = a.entity_type and fs.entity_id = a.entity_id
               and fs.field_name = a.field_name
        where a.entity_type = $1 and a.entity_id = $2
        order by a.at, a.id`,
      [entityType, entityId],
    );

    return rows.map((row) => {
      // 'withheld' is the owner's ruling that a value is not published even
      // though it is known. A history that reprinted it would be a way around
      // that ruling.
      const withheld = row.state === 'withheld';
      const entry: AuditRow = {
        at: row.at.toISOString(), actor: row.actor, action: row.action,
        entityType: row.entity_type, entityId: row.entity_id,
      };
      if (row.field_name !== null) entry.fieldName = row.field_name;
      if (row.prior_value !== null) entry.priorValue = withheld ? REDACTED : row.prior_value;
      if (row.new_value !== null) entry.newValue = withheld ? REDACTED : row.new_value;
      if (row.detail !== null) entry.detail = row.detail;
      if (withheld) entry.redacted = true;
      return entry;
    });
  }
}
