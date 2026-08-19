/**
 * The RA 11032 processing pledge, computed in exactly one place.
 *
 * This is a compliance mechanism, not a countdown widget. RA 11032 prescribes
 * processing periods by transaction classification and obliges the LGU to
 * publish them in its Citizen's Charter; ARTA measures against them. So the
 * governing principle here is **never assert a pledge the LGU has not made, and
 * never accuse it of lateness it has not incurred.**
 *
 * That principle decides every awkward case below:
 *
 * - No Citizen's Charter entry → **no countdown at all.** Not a guess, not a
 *   default of "7 days". The clients say "Awaiting classification".
 * - Holiday calendar incomplete for a year the period spans → the date is
 *   returned but flagged **approximate**, because a proclamation issued later
 *   can move it. Under-counting working days would make the LGU look late when
 *   it is not.
 * - Time the applicant spent holding a deficiency is **excluded**, because RA
 *   11032 excludes it. Counting it would attribute the applicant's delay to the
 *   LGU.
 *
 * All arithmetic is in Philippine local dates. The Philippines has no daylight
 * saving, but a fixed offset is not assumed in perpetuity: dates are derived by
 * shifting to +08:00 explicitly, so a future change is one constant.
 */

export const PH_UTC_OFFSET_MINUTES = 8 * 60;

export type Classification = 'Simple' | 'Complex' | 'Highly Technical';

export interface HolidayCalendar {
  /** Years for which a proclamation has been issued IN FULL. */
  readonly completeYears: ReadonlySet<number>;
  /** 'YYYY-MM-DD' in Philippine local time. */
  readonly holidays: ReadonlySet<string>;
}

/** A span the applicant held the application, excluded from the count. */
export interface Suspension {
  readonly from: Date;
  /** Null while still suspended. */
  readonly to: Date | null;
}

export interface PledgeInput {
  readonly classification: Classification | null;
  readonly pledgedWorkingDays: number | null;
  /** When the LGU took carriage — the filing, not the draft. */
  readonly startedAt: Date | null;
  readonly now: Date;
  readonly calendar: HolidayCalendar;
  readonly suspensions: readonly Suspension[];
  /** True once the LGU has finished; the clock stops for good. */
  readonly completedAt?: Date | null;
}

export interface Pledge {
  readonly classification: Classification;
  readonly pledgedWorkingDays: number;
  /** 'YYYY-MM-DD'. Null only when the span cannot be resolved at all. */
  readonly dueDate: string | null;
  readonly workingDaysElapsed: number;
  readonly workingDaysRemaining: number;
  /**
   * A proclamation for a year the period spans has not been issued in full, so
   * this date could move. The clients must present it as approximate rather
   * than assert it.
   */
  readonly approximate: boolean;
  readonly suspended: boolean;
  readonly overdue: boolean;
}

/** Philippine local date, as 'YYYY-MM-DD'. */
export function phDate(at: Date): string {
  const shifted = new Date(at.getTime() + PH_UTC_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const [y = 0, m = 1, d = 1] = isoDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

function isWeekend(isoDate: string): boolean {
  const [y = 0, m = 1, d = 1] = isoDate.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

export function isWorkingDay(isoDate: string, calendar: HolidayCalendar): boolean {
  return !isWeekend(isoDate) && !calendar.holidays.has(isoDate);
}

/** Whether every year the span touches has a complete proclamation. */
function spanIsFullyKnown(fromIso: string, toIso: string, calendar: HolidayCalendar): boolean {
  const first = Number(fromIso.slice(0, 4));
  const last = Number(toIso.slice(0, 4));
  for (let year = first; year <= last; year += 1) {
    if (!calendar.completeYears.has(year)) return false;
  }
  return true;
}

/**
 * Working days between two dates, excluding any day inside a suspension.
 *
 * The start date itself is not counted: RA 11032 periods run from the day
 * AFTER the LGU takes carriage, which is also how a counter clerk would count.
 */
export function workingDaysBetween(
  fromIso: string,
  toIso: string,
  calendar: HolidayCalendar,
  suspendedDays: ReadonlySet<string>,
): number {
  if (toIso <= fromIso) return 0;

  let count = 0;
  let cursor = addDays(fromIso, 1);
  // A hard bound, so a bad input cannot spin: ten years of daily steps.
  for (let guard = 0; cursor <= toIso && guard < 3_700; guard += 1) {
    if (isWorkingDay(cursor, calendar) && !suspendedDays.has(cursor)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/** Every Philippine local date covered by a suspension. */
export function suspendedDates(suspensions: readonly Suspension[], upTo: Date): Set<string> {
  const dates = new Set<string>();
  for (const suspension of suspensions) {
    const from = phDate(suspension.from);
    const to = phDate(suspension.to ?? upTo);
    let cursor = from;
    for (let guard = 0; cursor <= to && guard < 3_700; guard += 1) {
      dates.add(cursor);
      cursor = addDays(cursor, 1);
    }
  }
  return dates;
}

/**
 * The date the pledge falls due: `pledgedWorkingDays` working days after the
 * start, skipping weekends, holidays and suspended days.
 */
export function dueDateFor(
  startIso: string,
  pledgedWorkingDays: number,
  calendar: HolidayCalendar,
  suspendedDays: ReadonlySet<string>,
): string | null {
  let remaining = pledgedWorkingDays;
  let cursor = startIso;
  for (let guard = 0; remaining > 0 && guard < 3_700; guard += 1) {
    cursor = addDays(cursor, 1);
    if (isWorkingDay(cursor, calendar) && !suspendedDays.has(cursor)) remaining -= 1;
  }
  return remaining === 0 ? cursor : null;
}

/**
 * The whole computation.
 *
 * Returns null — meaning "no countdown at all" — when the LGU has made no
 * pledge for this permit type, or when the application has not been filed.
 * Callers must render that as "Awaiting classification" rather than as a blank
 * or a zero.
 */
export function computePledge(input: PledgeInput): Pledge | null {
  const { classification, pledgedWorkingDays, startedAt, now, calendar, suspensions } = input;

  // The governing rule. No charter entry means no promise was made, and
  // inventing one risks accusing the LGU of missing a pledge it never gave.
  if (classification === null || pledgedWorkingDays === null || startedAt === null) return null;
  if (pledgedWorkingDays <= 0) return null;

  const startIso = phDate(startedAt);
  const asOf = input.completedAt ?? now;
  const asOfIso = phDate(asOf);

  const suspended = suspensions.some((suspension) => suspension.to === null);
  const suspendedDays = suspendedDates(suspensions, asOf);

  const dueDate = dueDateFor(startIso, pledgedWorkingDays, calendar, suspendedDays);
  const elapsed = workingDaysBetween(startIso, asOfIso, calendar, suspendedDays);
  const remaining = pledgedWorkingDays - elapsed;

  const horizon = dueDate ?? asOfIso;
  const approximate = !spanIsFullyKnown(startIso, horizon > asOfIso ? horizon : asOfIso, calendar);

  return {
    classification,
    pledgedWorkingDays,
    dueDate,
    workingDaysElapsed: elapsed,
    workingDaysRemaining: remaining,
    approximate,
    suspended,
    // Only claimed when the calendar is known: calling the LGU late on an
    // approximate date is the one error this must not make.
    overdue: !approximate && remaining < 0,
  };
}
