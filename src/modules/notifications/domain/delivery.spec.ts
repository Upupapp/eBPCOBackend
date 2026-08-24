import { CATALOG, entryFor } from './catalog';
import { DEFAULT_PREFERENCES, Preferences, insideQuietHours, nextOpenWindow, planDelivery } from './delivery';

// Every test pins the clock. An unpinned quiet-hours test passes in the morning
// and fails at night, and CI runs at all hours.
//
// Every fixture carries +08:00 EXPLICITLY. They were written as `Z` and named
// for the Manila hour they were meant to represent — `NIGHT` was 23:00Z, which
// is seven in the morning in Manila. So the suite asserted the eight-hour slide
// rather than catching it, and read as if it had proved the opposite. The
// offset is in the literal now so the name and the instant cannot drift apart.
const DAYTIME = new Date('2026-08-19T10:00:00+08:00');
const NIGHT = new Date('2026-08-19T23:00:00+08:00');
const EARLY_HOURS = new Date('2026-08-19T03:00:00+08:00');

const plan = (type: string, overrides: Partial<Preferences> = {}, now = DAYTIME, hasDevice = true) =>
  planDelivery({
    entry: entryFor(type)!,
    preferences: { ...DEFAULT_PREFERENCES, ...overrides },
    now,
    hasDevice,
  });

describe('quiet hours wrap midnight', () => {
  // The obvious implementation — start <= now && now < end — sends every push
  // between midnight and 07:00.
  const window = DEFAULT_PREFERENCES.quietHours;

  it.each([
    ['21:00, the moment it starts', '2026-08-19T21:00:00+08:00', true],
    ['23:00, before midnight', '2026-08-19T23:00:00+08:00', true],
    ['03:00, after midnight', '2026-08-19T03:00:00+08:00', true],
    ['06:59, just before it lifts', '2026-08-19T06:59:00+08:00', true],
    ['07:00, the moment it lifts', '2026-08-19T07:00:00+08:00', false],
    ['10:00, mid-morning', '2026-08-19T10:00:00+08:00', false],
    ['20:59, just before it starts', '2026-08-19T20:59:00+08:00', false],
  ])('%s in Manila is inside=%s', (_label, iso, expected) => {
    expect(insideQuietHours(new Date(iso), window)).toBe(expected);
  });

  // The regression proper, stated in the frame the server actually runs in.
  // Under the old comparison every one of these was inverted: the LGU's working
  // morning was held and the applicant's night was not.
  it.each([
    ['15:00Z — 23:00 in Manila, the middle of the evening', '2026-08-19T15:00:00Z', true],
    ['20:00Z — 04:00 in Manila, asleep', '2026-08-19T20:00:00Z', true],
    ['23:00Z — 07:00 in Manila, awake', '2026-08-19T23:00:00Z', false],
    ['01:00Z — 09:00 in Manila, the office is open', '2026-08-19T01:00:00Z', false],
    ['06:00Z — 14:00 in Manila, mid-afternoon', '2026-08-19T06:00:00Z', false],
  ])('%s', (_label, iso, expected) => {
    expect(insideQuietHours(new Date(iso), window)).toBe(expected);
  });

  it('is never inside when the applicant has turned it off', () => {
    expect(insideQuietHours(NIGHT, { ...window, enabled: false })).toBe(false);
  });

  // 07:00 in Manila is 23:00Z the previous day. Asserting `07:00Z` here is what
  // made the old expectations look right while naming the wrong instant.
  it('opens at 07:00 Manila the same morning when it is already past midnight', () => {
    expect(nextOpenWindow(EARLY_HOURS, window).toISOString()).toBe('2026-08-18T23:00:00.000Z');
  });

  it('opens at 07:00 Manila the NEXT morning when it is still the evening', () => {
    expect(nextOpenWindow(NIGHT, window).toISOString()).toBe('2026-08-19T23:00:00.000Z');
  });

  it('always opens at the end time on a Manila wall clock, whatever the UTC date', () => {
    // The property, rather than two more pinned instants: whenever the window
    // opens, a clock in Manila reads exactly `end`.
    for (const iso of ['2026-08-19T15:00:00Z', '2026-08-19T20:00:00Z', '2026-01-01T16:30:00Z']) {
      const opens = nextOpenWindow(new Date(iso), window);
      const manila = new Date(opens.getTime() + 8 * 60 * 60_000);
      expect(`${String(manila.getUTCHours()).padStart(2, '0')}:${String(manila.getUTCMinutes()).padStart(2, '0')}`)
        .toBe(window.end);
      expect(opens.getTime()).toBeGreaterThan(new Date(iso).getTime());
    }
  });
});

describe('email is the record of notice', () => {
  it('goes out for every notification in the catalog', () => {
    for (const entry of CATALOG) {
      expect(plan(entry.type).immediate).toContain('email');
    }
  });

  it('goes out even inside quiet hours, because it makes no noise', () => {
    expect(plan('order-of-payment-issued', {}, NIGHT).immediate).toContain('email');
  });

  it('goes out even when the category is muted', () => {
    // A mute is a preference about noise, not a waiver of notice.
    expect(plan('received-by-obo', { mutedCategories: ['applicationUpdates'] }).immediate).toContain('email');
  });
});

describe('push is a convenience, and can be silenced', () => {
  it('goes out immediately in daytime when a device is registered', () => {
    expect(plan('received-by-obo').immediate).toContain('push');
  });

  it('is suppressed when the category is muted', () => {
    const result = plan('received-by-obo', { mutedCategories: ['applicationUpdates'] });

    expect(result.suppressed).toContain('push');
    expect(result.immediate).not.toContain('push');
    expect(result.reasons.push).toContain('muted');
  });

  it('is suppressed when no device is registered', () => {
    const result = plan('received-by-obo', {}, DAYTIME, false);

    expect(result.suppressed).toContain('push');
    expect(result.reasons.push).toContain('no device');
  });

  it('is DEFERRED inside quiet hours, never dropped', () => {
    // A notice that would have arrived at 23:00 is still a notice.
    const result = plan('received-by-obo', {}, NIGHT);

    expect(result.deferred).toContain('push');
    expect(result.suppressed).not.toContain('push');
    // 07:00 on the 20th in Manila — which is 23:00Z on the 19th.
    expect(result.deferredUntil?.toISOString()).toBe('2026-08-19T23:00:00.000Z');
  });

  it('is sent immediately when the applicant has turned quiet hours off', () => {
    const result = plan('received-by-obo', {
      quietHours: { enabled: false, start: '21:00', end: '07:00' },
    }, NIGHT);

    expect(result.immediate).toContain('push');
  });
});

describe('SMS backs up notices that start a clock', () => {
  // Decision E-9. A push to an uninstalled app reaches nobody, and RA 11032
  // periods run against notices the applicant is assumed to have received.

  it.each([
    'revision-required',
    'order-of-payment-issued',
    'ready-for-release',
    'payment-overdue',
    'pledge-lapsed',
    'inspection-scheduled',
  ])('is sent for %s', (type) => {
    expect(plan(type).immediate).toContain('sms');
  });

  it.each([
    'received-by-obo',
    'evaluation-stage-passed',
    'payment-verified',
    'occupancy-now-possible',
  ])('is NOT sent for %s, which costs nothing to miss', (type) => {
    const result = plan(type);
    expect(result.immediate).not.toContain('sms');
    expect(result.deferred).not.toContain('sms');
  });

  it('is not silenced by muting the category', () => {
    // Muting suppresses the push. It does not waive a notice with a statutory
    // consequence.
    const result = plan('order-of-payment-issued', { mutedCategories: ['payments'] });

    expect(result.immediate).toContain('sms');
    expect(result.suppressed).toContain('push');
    expect(result.reasons.smsMuteIgnored).toContain('statutory');
  });

  it('is deferred inside quiet hours rather than waking someone at 23:00', () => {
    const result = plan('order-of-payment-issued', {}, NIGHT);

    expect(result.deferred).toContain('sms');
    expect(result.immediate).not.toContain('sms');
  });
});

describe('every notice reaches at least one channel', () => {
  it('holds for every catalog entry, in every combination of preferences', () => {
    // The property that matters: no combination of muting, quiet hours and a
    // missing device can result in the LGU having told nobody anything.
    for (const entry of CATALOG) {
      for (const now of [DAYTIME, NIGHT, EARLY_HOURS]) {
        for (const hasDevice of [true, false]) {
          const result = planDelivery({
            entry,
            preferences: {
              mutedCategories: ['applicationUpdates', 'documentReminders', 'payments', 'appointments', 'permitStatus'],
              quietHours: DEFAULT_PREFERENCES.quietHours,
            },
            now,
            hasDevice,
          });

          expect([...result.immediate, ...result.deferred].length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never suppresses a statutory notice entirely', () => {
    for (const entry of CATALOG.filter((e) => e.statutory)) {
      const result = planDelivery({
        entry,
        preferences: { mutedCategories: [entry.category], quietHours: DEFAULT_PREFERENCES.quietHours },
        now: NIGHT,
        hasDevice: false,
      });

      expect([...result.immediate, ...result.deferred]).toEqual(expect.arrayContaining(['email']));
      expect([...result.immediate, ...result.deferred]).toEqual(expect.arrayContaining(['sms']));
    }
  });
});
