import { SqlClient } from '../../../persistence/sql-client';
import { Classification, HolidayCalendar, Suspension, computePledge } from '../domain/pledge-clock';

/**
 * How the LGU is doing against its own Citizen's Charter.
 *
 * Shaped for ARTA reporting: RA 11032 obliges the LGU to publish processing
 * periods and be measured against them, and the measurement has to come from
 * somewhere. Deriving it from the audit trail later is far harder than
 * computing it from the records now.
 *
 * Two things it will not do:
 *
 * It does not count an application whose pledge is **approximate** as either
 * met or missed. A proclamation issued later can add working days, and putting
 * an LGU in the "missed" column on a date that could still move is the single
 * worst error this report could make.
 *
 * It does not count an **unclassified** application at all. No charter entry
 * means no promise, and a promise nobody made cannot be broken.
 */

export interface ComplianceRow {
  readonly permitType: string;
  readonly classification: Classification;
  readonly pledgedWorkingDays: number;
  readonly total: number;
  readonly withinPledge: number;
  readonly beyondPledge: number;
  /** Excluded from the verdict because the calendar for the span is incomplete. */
  readonly indeterminate: number;
  readonly complianceRate: number | null;
}

export interface ComplianceReport {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly ComplianceRow[];
  readonly totalMeasured: number;
  /** Applications with no charter entry, so no pledge was ever made. */
  readonly unclassified: number;
  readonly overallComplianceRate: number | null;
}

interface ApplicationRow {
  id: string;
  permit_type: string;
  classification: Classification | null;
  pledged_working_days: number | null;
  submitted_at: Date | null;
  completed_at: Date | null;
  suspended_from: Date | null;
  suspended_to: Date | null;
}

export async function complianceReport(
  db: SqlClient,
  options: { from: string; to: string; calendar: HolidayCalendar; now: Date },
): Promise<ComplianceReport> {
  const { from, to, calendar, now } = options;

  const rows = await db.query<ApplicationRow>(
    `select a.id, a.permit_type, a.classification, c.pledged_working_days,
            a.submitted_at,
            (select max(t.occurred_at) from application_transitions t
              where t.application_id = a.id
                and t.to_status in ('Released', 'Completed', 'Rejected')) as completed_at,
            (select min(t.occurred_at) from application_transitions t
              where t.application_id = a.id and t.to_status = 'Revision Required') as suspended_from,
            (select min(t.occurred_at) from application_transitions t
              where t.application_id = a.id and t.from_status = 'Revision Required'
                and t.to_status = 'Under Evaluation') as suspended_to
       from applications a
       left join charter_entries c
         on c.permit_type = a.permit_type
        and c.effective_from <= a.submitted_at::date
        and (c.effective_to is null or c.effective_to > a.submitted_at::date)
      where a.submitted_at >= $1 and a.submitted_at < $2`,
    [from, to],
  );

  // A mutable accumulator, kept distinct from the readonly result shape so the
  // published report cannot be edited by whoever receives it.
  interface Bucket {
    permitType: string;
    classification: Classification;
    pledgedWorkingDays: number;
    total: number;
    within: number;
    beyond: number;
    indet: number;
  }

  const buckets = new Map<string, Bucket>();
  let unclassified = 0;

  for (const row of rows.rows) {
    const suspensions: Suspension[] =
      row.suspended_from === null ? [] : [{ from: row.suspended_from, to: row.suspended_to }];

    const pledge = computePledge({
      classification: row.classification,
      pledgedWorkingDays: row.pledged_working_days,
      startedAt: row.submitted_at,
      now,
      calendar,
      suspensions,
      completedAt: row.completed_at,
    });

    if (pledge === null) {
      // No charter entry: no promise was made, so there is nothing to measure.
      unclassified += 1;
      continue;
    }

    const key = `${row.permit_type}|${pledge.classification}`;
    const bucket: Bucket = buckets.get(key) ?? {
      permitType: row.permit_type,
      classification: pledge.classification,
      pledgedWorkingDays: pledge.pledgedWorkingDays,
      total: 0, within: 0, beyond: 0, indet: 0,
    };

    bucket.total += 1;
    if (pledge.approximate) {
      // Not counted either way. A date that could still move is not evidence.
      bucket.indet += 1;
    } else if (pledge.workingDaysRemaining >= 0) {
      bucket.within += 1;
    } else {
      bucket.beyond += 1;
    }
    buckets.set(key, bucket);
  }

  const finalRows: ComplianceRow[] = [...buckets.values()].map((bucket) => {
    const measured = bucket.within + bucket.beyond;
    return {
      permitType: bucket.permitType,
      classification: bucket.classification,
      pledgedWorkingDays: bucket.pledgedWorkingDays,
      total: bucket.total,
      withinPledge: bucket.within,
      beyondPledge: bucket.beyond,
      indeterminate: bucket.indet,
      // Null rather than 100% when nothing is measurable: a rate computed over
      // zero applications reads as perfect compliance.
      complianceRate: measured === 0 ? null : bucket.within / measured,
    };
  });

  const totalWithin = finalRows.reduce((sum, row) => sum + row.withinPledge, 0);
  const totalBeyond = finalRows.reduce((sum, row) => sum + row.beyondPledge, 0);
  const measured = totalWithin + totalBeyond;

  return {
    from, to,
    rows: finalRows.sort((a, b) => (a.permitType < b.permitType ? -1 : 1)),
    totalMeasured: measured,
    unclassified,
    overallComplianceRate: measured === 0 ? null : totalWithin / measured,
  };
}
