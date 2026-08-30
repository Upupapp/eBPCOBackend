import { SqlClient } from '../../../persistence/sql-client';
import { HolidayCalendar } from '../domain/pledge-clock';

/**
 * Injection token, declared beside the port rather than in the module that
 * binds it.
 *
 * It lived in `applications.module.ts`, which meant a consumer had to import
 * that module to name the token — and the module imports its consumers. The
 * compliance report's controller closed that loop and the token arrived
 * `undefined` at construction time, exactly as the account repository's own
 * comment warns. Same defect, same fix, second occurrence.
 */
export const CALENDAR_REPOSITORY = Symbol('EBPCO_CALENDAR_REPOSITORY');


/**
 * The proclaimed calendar, loaded once.
 *
 * The pledge clock takes a calendar rather than reading one, so it stays pure
 * and testable; this is the one place that turns the two tables into that
 * shape. It exists because the alternative — every caller assembling its own —
 * is how two parts of a system end up disagreeing about whether a day was a
 * holiday, and therefore about whether an LGU met a statutory deadline.
 *
 * `completeYears` carries only years whose proclamation has been issued in
 * full. A year absent from that set does not make its holidays unusable: the
 * dates already proclaimed still count, and what changes is that any pledge
 * spanning the year is marked approximate rather than asserted. That is the
 * honest presentation of a deadline that could still move (M-12).
 */
export interface CalendarRepository {
  load(): Promise<HolidayCalendar>;
}

export class SqlCalendarRepository implements CalendarRepository {
  constructor(private readonly db: SqlClient) {}

  async load(): Promise<HolidayCalendar> {
    const [years, dates] = await Promise.all([
      this.db.query<{ year: number }>('select year from holiday_calendars where complete'),
      this.db.query<{ d: string }>("select to_char(holiday_date, 'YYYY-MM-DD') as d from holidays"),
    ]);

    return {
      completeYears: new Set(years.rows.map((row) => Number(row.year))),
      holidays: new Set(dates.rows.map((row) => row.d)),
    };
  }
}

/**
 * A calendar with nothing in it, and no year marked complete.
 *
 * Used where a calendar genuinely is not available. It does not pretend the
 * weekdays are all working days it can vouch for: because no year is complete,
 * every pledge computed against it comes back approximate, which is exactly
 * what the client should show when the LGU's calendar has not been loaded.
 */
export const EMPTY_CALENDAR: HolidayCalendar = {
  completeYears: new Set<number>(),
  holidays: new Set<string>(),
};

/**
 * Caches the calendar for a bounded time.
 *
 * A proclamation is issued a handful of times a year, and re-reading two tables
 * on every queue page is waste. The TTL rather than a permanent cache is
 * deliberate: when a movable holiday is finally proclaimed, a long-running
 * process must pick it up without a restart, because the alternative is an
 * office computing deadlines against a calendar that was correct in March.
 */
export class CachingCalendarRepository implements CalendarRepository {
  private cached: { at: number; calendar: HolidayCalendar } | null = null;

  constructor(
    private readonly inner: CalendarRepository,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async load(): Promise<HolidayCalendar> {
    const now = this.clock().getTime();
    if (this.cached !== null && now - this.cached.at < this.ttlMs) return this.cached.calendar;
    const calendar = await this.inner.load();
    this.cached = { at: now, calendar };
    return calendar;
  }
}
