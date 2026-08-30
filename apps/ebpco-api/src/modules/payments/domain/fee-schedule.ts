import { FeeLine } from './order-of-payment';

/**
 * The LGU's published fee schedule.
 *
 * Reference data, effective-dated, and **shipped empty**. This is M-08: the
 * schedule is LGU-published material and inventing a plausible-looking figure
 * would be worse than having none — an applicant would be quoted a fee the LGU
 * never set, and would have no way to know.
 *
 * An assessment records which version it was computed under, so a historical
 * Order of Payment can always be explained against the schedule that was in
 * force when it was made rather than the one in force when the question is
 * asked.
 */

export interface FeeScheduleEntry {
  readonly permitType: string;
  readonly line: FeeLine;
  readonly amountCentavos: number;
  readonly basis: string;
}

export interface FeeSchedule {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly entries: readonly FeeScheduleEntry[];
}

export class FeeScheduleUnavailable extends Error {
  constructor(readonly permitType: string) {
    super(
      `no published fee schedule covers ${permitType}. The LGU's schedule (M-08) has not been loaded, ` +
        'and a fee cannot be invented.',
    );
  }
}

/**
 * Selects the schedule in force on a date.
 *
 * Returns null rather than falling back to the newest: quoting an applicant a
 * fee from a schedule that was not in force when they filed is exactly the
 * error the effective dating exists to prevent.
 */
export function scheduleInForce(
  schedules: readonly FeeSchedule[],
  on: string,
): FeeSchedule | null {
  const applicable = schedules.filter(
    (schedule) => schedule.effectiveFrom <= on && (schedule.effectiveTo === null || schedule.effectiveTo > on),
  );
  if (applicable.length === 0) return null;

  // Later effectiveFrom wins if two overlap, but overlapping schedules are a
  // data error the loader should refuse; this is a safety net, not a policy.
  return applicable.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}

export function amountsFor(
  schedule: FeeSchedule,
  permitType: string,
): { amounts: Partial<Record<FeeLine, number>>; bases: Partial<Record<FeeLine, string>> } {
  const entries = schedule.entries.filter((entry) => entry.permitType === permitType);
  if (entries.length === 0) throw new FeeScheduleUnavailable(permitType);

  const amounts: Partial<Record<FeeLine, number>> = {};
  const bases: Partial<Record<FeeLine, string>> = {};
  for (const entry of entries) {
    amounts[entry.line] = entry.amountCentavos;
    bases[entry.line] = entry.basis;
  }
  return { amounts, bases };
}
