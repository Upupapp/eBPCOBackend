import {
  HolidayCalendar,
  computePledge,
  dueDateFor,
  isWorkingDay,
  phDate,
  suspendedDates,
  workingDaysBetween,
} from './pledge-clock';

/** 2026 with a complete proclamation and a handful of real Philippine holidays. */
const calendar2026: HolidayCalendar = {
  completeYears: new Set([2026]),
  holidays: new Set([
    '2026-01-01', // New Year's Day
    '2026-04-09', // Araw ng Kagitingan
    '2026-05-01', // Labor Day
    '2026-06-12', // Independence Day
    '2026-08-21', // Ninoy Aquino Day
    '2026-08-31', // National Heroes Day
    '2026-11-30', // Bonifacio Day
    '2026-12-25', // Christmas Day
    '2026-12-30', // Rizal Day
  ]),
};

/** The same year, before the movable Islamic holidays are proclaimed (M-12). */
const incomplete2026: HolidayCalendar = { ...calendar2026, completeYears: new Set() };

const utc = (iso: string) => new Date(iso);
const noSuspension = new Set<string>();

describe('Philippine local dates', () => {
  it('rolls to the next day for a late-evening UTC instant', () => {
    // 17:00 UTC on the 19th is 01:00 on the 20th in Manila. An applicant filing
    // at 1am should not have their pledge start the previous day.
    expect(phDate(utc('2026-08-19T17:00:00Z'))).toBe('2026-08-20');
    expect(phDate(utc('2026-08-19T15:59:00Z'))).toBe('2026-08-19');
  });
});

describe('what counts as a working day', () => {
  it('excludes weekends', () => {
    expect(isWorkingDay('2026-08-22', calendar2026)).toBe(false); // Saturday
    expect(isWorkingDay('2026-08-23', calendar2026)).toBe(false); // Sunday
    expect(isWorkingDay('2026-08-24', calendar2026)).toBe(true);  // Monday
  });

  it('excludes proclaimed holidays', () => {
    expect(isWorkingDay('2026-08-21', calendar2026)).toBe(false); // Ninoy Aquino Day
    expect(isWorkingDay('2026-06-12', calendar2026)).toBe(false); // Independence Day
  });

  it('counts an ordinary weekday', () => {
    expect(isWorkingDay('2026-08-19', calendar2026)).toBe(true);
  });
});

describe('counting working days', () => {
  it('does not count the start day itself', () => {
    // RA 11032 periods run from the day AFTER the LGU takes carriage, which is
    // also how a counter clerk counts.
    expect(workingDaysBetween('2026-08-19', '2026-08-19', calendar2026, noSuspension)).toBe(0);
    expect(workingDaysBetween('2026-08-19', '2026-08-20', calendar2026, noSuspension)).toBe(1);
  });

  it('skips the weekend and any holiday inside the span', () => {
    // Wed 19th to Mon 24th. Thu 20th counts; Fri 21st is Ninoy Aquino Day; Sat
    // and Sun do not; Mon 24th counts. Two, not three — the first version of
    // this expectation said three because I forgot a holiday in my own
    // calendar, and independent arithmetic settled it.
    expect(workingDaysBetween('2026-08-19', '2026-08-24', calendar2026, noSuspension)).toBe(2);
  });

  it('skips a holiday that falls midweek', () => {
    // Wed 19th to Sat 22nd: Thu 20th, Fri 21st is Ninoy Aquino Day → 1.
    expect(workingDaysBetween('2026-08-19', '2026-08-22', calendar2026, noSuspension)).toBe(1);
  });

  it('skips days the applicant held the application', () => {
    const held = new Set(['2026-08-20', '2026-08-24']);
    expect(workingDaysBetween('2026-08-19', '2026-08-25', calendar2026, held)).toBe(1);
  });

  it('returns zero when the end precedes the start', () => {
    expect(workingDaysBetween('2026-08-19', '2026-08-01', calendar2026, noSuspension)).toBe(0);
  });
});

describe('the due date', () => {
  it('lands three working days out, skipping the weekend', () => {
    // Wed 19th + 3 working days = Thu 20th, (Fri 21st holiday), Mon 24th, Tue 25th.
    expect(dueDateFor('2026-08-19', 3, calendar2026, noSuspension)).toBe('2026-08-25');
  });

  it('lands seven working days out for a complex transaction', () => {
    // Not 31 August: that is National Heroes Day, so the seventh working day
    // falls on 1 September.
    expect(dueDateFor('2026-08-19', 7, calendar2026, noSuspension)).toBe('2026-09-01');
  });

  it('moves out by the days the applicant held it', () => {
    const held = new Set(['2026-08-24', '2026-08-25', '2026-08-26']);
    expect(dueDateFor('2026-08-19', 3, calendar2026, held)).toBe('2026-08-28');
  });
});

describe('no charter entry means no countdown at all', () => {
  // The governing rule: never assert a pledge the LGU has not made. This is
  // what makes the clients say "Awaiting classification" rather than showing a
  // blank or a zero.

  it('returns null when the permit type is unclassified', () => {
    expect(
      computePledge({
        classification: null, pledgedWorkingDays: null,
        startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-24T02:00:00Z'),
        calendar: calendar2026, suspensions: [],
      }),
    ).toBeNull();
  });

  it('returns null when a classification exists but no pledged period does', () => {
    expect(
      computePledge({
        classification: 'Complex', pledgedWorkingDays: null,
        startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-24T02:00:00Z'),
        calendar: calendar2026, suspensions: [],
      }),
    ).toBeNull();
  });

  it('returns null before the application is filed', () => {
    // A draft is not something the LGU has taken carriage of.
    expect(
      computePledge({
        classification: 'Simple', pledgedWorkingDays: 3, startedAt: null,
        now: utc('2026-08-24T02:00:00Z'), calendar: calendar2026, suspensions: [],
      }),
    ).toBeNull();
  });
});

describe('a live pledge', () => {
  const live = (now: string, suspensions: Parameters<typeof computePledge>[0]['suspensions'] = []) =>
    computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc(now),
      calendar: calendar2026, suspensions,
    });

  it('reports elapsed and remaining working days', () => {
    const pledge = live('2026-08-24T02:00:00Z');

    expect(pledge?.workingDaysElapsed).toBe(2);
    expect(pledge?.workingDaysRemaining).toBe(5);
    expect(pledge?.dueDate).toBe('2026-09-01');
  });

  it('is not overdue while days remain', () => {
    expect(live('2026-08-24T02:00:00Z')?.overdue).toBe(false);
  });

  it('is overdue once the period is exceeded on a known calendar', () => {
    const pledge = live('2026-09-08T02:00:00Z');

    expect(pledge?.workingDaysRemaining).toBeLessThan(0);
    expect(pledge?.overdue).toBe(true);
  });
});

describe('the clock stops while the applicant holds a deficiency', () => {
  // RA 11032 excludes that time. Counting it would attribute the applicant's
  // delay to the LGU.

  it('does not count suspended days as elapsed', () => {
    const withSuspension = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-28T02:00:00Z'),
      calendar: calendar2026,
      suspensions: [{ from: utc('2026-08-24T02:00:00Z'), to: utc('2026-08-27T02:00:00Z') }],
    });
    const without = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-28T02:00:00Z'),
      calendar: calendar2026, suspensions: [],
    });

    expect(withSuspension!.workingDaysElapsed).toBeLessThan(without!.workingDaysElapsed);
  });

  it('pushes the due date out by the days held', () => {
    const pledge = computePledge({
      classification: 'Simple', pledgedWorkingDays: 3,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-28T02:00:00Z'),
      calendar: calendar2026,
      suspensions: [{ from: utc('2026-08-24T02:00:00Z'), to: utc('2026-08-26T02:00:00Z') }],
    });

    // Without the suspension the third working day is 25 August. Holding it
    // from the 24th to the 26th pushes it to the 28th.
    expect(pledge?.dueDate).toBe('2026-08-28');
  });

  it('reports itself suspended while the deficiency is still open', () => {
    const pledge = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-28T02:00:00Z'),
      calendar: calendar2026,
      suspensions: [{ from: utc('2026-08-24T02:00:00Z'), to: null }],
    });

    expect(pledge?.suspended).toBe(true);
  });

  it('is not suspended once the applicant has resubmitted', () => {
    const pledge = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-28T02:00:00Z'),
      calendar: calendar2026,
      suspensions: [{ from: utc('2026-08-24T02:00:00Z'), to: utc('2026-08-26T02:00:00Z') }],
    });

    expect(pledge?.suspended).toBe(false);
  });

  it('never counts a suspended period as making the LGU late', () => {
    // The whole point. An applicant who sits on a Letter of Instruction for a
    // month must not make the LGU appear to have missed its pledge.
    const pledge = computePledge({
      classification: 'Simple', pledgedWorkingDays: 3,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-09-30T02:00:00Z'),
      calendar: calendar2026,
      suspensions: [{ from: utc('2026-08-20T02:00:00Z'), to: utc('2026-09-29T02:00:00Z') }],
    });

    expect(pledge?.overdue).toBe(false);
  });
});

describe('an incomplete holiday calendar', () => {
  // The movable Islamic holidays are proclaimed during the year (M-12), so a
  // year is not fully known until they are.

  it('flags the date as approximate rather than asserting it', () => {
    const pledge = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-24T02:00:00Z'),
      calendar: incomplete2026, suspensions: [],
    });

    expect(pledge?.approximate).toBe(true);
    expect(pledge?.dueDate).not.toBeNull();
  });

  it('is not approximate when every year the span touches is proclaimed', () => {
    const pledge = computePledge({
      classification: 'Complex', pledgedWorkingDays: 7,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-08-24T02:00:00Z'),
      calendar: calendar2026, suspensions: [],
    });

    expect(pledge?.approximate).toBe(false);
  });

  it('is approximate when the period runs into a year not yet proclaimed', () => {
    const pledge = computePledge({
      classification: 'Highly Technical', pledgedWorkingDays: 20,
      startedAt: utc('2026-12-15T02:00:00Z'), now: utc('2026-12-20T02:00:00Z'),
      calendar: calendar2026, suspensions: [],
    });

    expect(pledge?.approximate).toBe(true);
  });

  it('NEVER calls the LGU overdue on an approximate date', () => {
    // The one error this must not make: a proclamation issued later can add
    // working days, and accusing the LGU of lateness on a date that could move
    // is worse than saying nothing.
    const pledge = computePledge({
      classification: 'Simple', pledgedWorkingDays: 3,
      startedAt: utc('2026-08-19T02:00:00Z'), now: utc('2026-09-30T02:00:00Z'),
      calendar: incomplete2026, suspensions: [],
    });

    expect(pledge?.workingDaysRemaining).toBeLessThan(0);
    expect(pledge?.overdue).toBe(false);
  });
});

describe('suspension day expansion', () => {
  it('covers every local date in the span, inclusive', () => {
    const dates = suspendedDates(
      [{ from: utc('2026-08-19T02:00:00Z'), to: utc('2026-08-21T02:00:00Z') }],
      utc('2026-08-25T02:00:00Z'),
    );

    expect([...dates].sort()).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
  });

  it('runs an open suspension up to the moment asked about', () => {
    const dates = suspendedDates(
      [{ from: utc('2026-08-19T02:00:00Z'), to: null }],
      utc('2026-08-22T02:00:00Z'),
    );

    expect(dates.size).toBe(4);
  });
});
