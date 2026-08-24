import { createHash } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { Centavos, centavos, parseCentavos } from '../domain/money';
import {
  AssessmentError,
  FeeLine,
  FeeLineItem,
  assertIssuable,
  buildLineItems,
} from '../domain/order-of-payment';
import { FeeSchedule, FeeScheduleUnavailable, amountsFor, scheduleInForce } from '../domain/fee-schedule';

/**
 * Issuing and correcting Orders of Payment.
 *
 * An issued Order is immutable — the database refuses an amendment (migration
 * 004) — so a correction is a new Order that supersedes the old one, with a
 * stated reason. Amending one after an applicant has been told what to pay is,
 * from their side, indistinguishable from being charged a different amount than
 * they were quoted.
 */

export type IssueResult =
  | { readonly ok: true; readonly orderId: string; readonly number: string; readonly total: Centavos }
  | { readonly ok: false; readonly reason: 'no-schedule' | 'already-assessed' | 'invalid'; readonly detail: string };

export class AssessmentService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async schedules(): Promise<FeeSchedule[]> {
    const versions = await this.db.query<{ version: string; effective_from: Date; effective_to: Date | null }>(
      'select version, effective_from, effective_to from fee_schedules order by effective_from desc',
    );
    const entries = await this.db.query<{
      version: string; permit_type: string; line: FeeLine; amount_centavos: number; basis: string;
    }>('select version, permit_type, line, amount_centavos, basis from fee_schedule_entries');

    return versions.rows.map((row) => ({
      version: row.version,
      effectiveFrom: isoDate(row.effective_from),
      effectiveTo: row.effective_to === null ? null : isoDate(row.effective_to),
      entries: entries.rows
        .filter((entry) => entry.version === row.version)
        .map((entry) => ({
          permitType: entry.permit_type,
          line: entry.line,
          amountCentavos: parseCentavos(entry.amount_centavos),
          basis: entry.basis,
        })),
    }));
  }

  async issue(options: {
    applicationId: string;
    officer: Caller;
    dueDate?: string;
  }): Promise<IssueResult> {
    const { applicationId, officer, dueDate } = options;

    const application = await this.db.query<{ permit_type: string }>(
      'select permit_type from applications where id = $1',
      [applicationId],
    );
    const permitType = application.rows[0]?.permit_type;
    if (permitType === undefined) {
      return { ok: false, reason: 'invalid', detail: 'no such application' };
    }

    const existing = await this.db.query<{ id: string }>(
      'select id from orders_of_payment where application_id = $1 and superseded_at is null',
      [applicationId],
    );
    if (existing.rows.length > 0) {
      // Correcting one is `supersede`, deliberately a different operation with
      // a different name and a required reason.
      return { ok: false, reason: 'already-assessed', detail: 'an Order of Payment is already in force' };
    }

    const schedule = scheduleInForce(await this.schedules(), isoDate(this.clock()));
    if (schedule === null) {
      // M-08. Quoting a fee from a schedule the LGU has not published, or from
      // one not in force on this date, is the error the effective dating exists
      // to prevent.
      return {
        ok: false,
        reason: 'no-schedule',
        detail: 'no LGU fee schedule is in force on this date; an Order of Payment cannot be issued',
      };
    }

    let items: FeeLineItem[];
    let total: Centavos;
    try {
      const { amounts, bases } = amountsFor(schedule, permitType);
      items = buildLineItems(amounts, bases);
      total = assertIssuable(items);
    } catch (error) {
      if (error instanceof FeeScheduleUnavailable || error instanceof AssessmentError) {
        return { ok: false, reason: 'no-schedule', detail: error.message };
      }
      throw error;
    }

    return this.insertOrder({ applicationId, officer, items, total, schedule, dueDate: dueDate ?? null });
  }

  /**
   * Corrects an Order by superseding it.
   *
   * The reason is required, not optional: an applicant whose bill changed is
   * owed an explanation, and "the assessment was revised" recorded against the
   * new Order is the only place that explanation can live.
   */
  async supersede(options: {
    orderId: string;
    reason: string;
    officer: Caller;
    items: readonly FeeLineItem[];
  }): Promise<IssueResult> {
    const { orderId, reason, officer, items } = options;

    if (reason.trim().length < 10) {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'superseding an Order of Payment requires a stated reason the applicant can read',
      };
    }

    const previous = await this.db.query<{ application_id: string; fee_schedule_version: string }>(
      'select application_id, fee_schedule_version from orders_of_payment where id = $1 and superseded_at is null',
      [orderId],
    );
    const row = previous.rows[0];
    if (row === undefined) {
      return { ok: false, reason: 'invalid', detail: 'no Order of Payment in force with that id' };
    }

    let total: Centavos;
    try {
      total = assertIssuable(items);
    } catch (error) {
      return { ok: false, reason: 'invalid', detail: (error as Error).message };
    }

    return this.db.transaction(async (tx) => {
      await tx.query(
        'update orders_of_payment set superseded_at = $1 where id = $2',
        [this.clock(), orderId],
      );
      return new AssessmentService(tx, this.clock).insertOrder({
        applicationId: row.application_id,
        officer,
        items,
        total,
        schedule: { version: row.fee_schedule_version, effectiveFrom: '', effectiveTo: null, entries: [] },
        dueDate: null,
        supersedes: { id: orderId, reason },
      });
    });
  }

  private async insertOrder(options: {
    applicationId: string;
    officer: Caller;
    items: readonly FeeLineItem[];
    total: Centavos;
    schedule: FeeSchedule;
    dueDate: string | null;
    supersedes?: { id: string; reason: string };
  }): Promise<IssueResult> {
    const { applicationId, officer, items, total, schedule, dueDate, supersedes } = options;

    // From the same atomic counter the permit numbers use (migration 010), not
    // a slice of a random UUID.
    //
    // An applicant reads this number to a cashier and writes it on a form.
    // `OP-2026-C92477BE` is materially harder to say, hear and transcribe than
    // `OP-2026-000019` — every character is one of thirty-six rather than one
    // of ten, and B/8, 0/O and 1/I are all in play at a counter. The randomness
    // also bought nothing: 32 bits is small enough to collide, and the number
    // is not a secret.
    const year = this.clock().getFullYear();
    const sequence = await this.db.query<{ last_issued: number }>(
      `insert into document_number_sequences (series, year, last_issued)
       values ('OP', $1, 1)
       on conflict (series, year)
         do update set last_issued = document_number_sequences.last_issued + 1
       returning last_issued`,
      [year],
    );
    const number = `OP-${year}-${String(Number(sequence.rows[0]?.last_issued ?? 1)).padStart(6, '0')}`;
    const by = (line: FeeLine): number => items.find((item) => item.line === line)?.amount ?? 0;

    const inserted = await this.db.query<{ id: string }>(
      `insert into orders_of_payment
         (application_id, number, filing_centavos, processing_centavos, architectural_centavos,
          structural_centavos, electrical_centavos, others_centavos, total_centavos,
          fee_schedule_version, assessed_at, assessed_by, due_date, supersedes_id, superseded_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning id`,
      [
        applicationId, number,
        by('filing'), by('processing'), by('architectural'),
        by('structural'), by('electrical'), by('others'), total,
        schedule.version, this.clock(), officer.accountId, dueDate,
        supersedes?.id ?? null, supersedes?.reason ?? null,
      ],
    );

    // The bases are stored alongside so an applicant can see what each line
    // rests on. Kept as a separate row set rather than columns, because the
    // number of lines is fixed but the citation for each is free text.
    for (const item of items) {
      if (item.amount === 0) continue;
      await this.audit.append({
        action: 'assessment.line-issued',
        subjectType: 'order-of-payment',
        subjectId: inserted.rows[0]?.id ?? '',
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        actorRole: officer.kind,
        afterState: { line: item.line, basis: item.basis },
      });
    }

    return { ok: true, orderId: inserted.rows[0]?.id ?? '', number, total };
  }
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A stable digest of a request body, for idempotency replay detection. */
export function requestDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body) ?? '', 'utf8').digest('hex');
}

export { centavos };
