import { CATALOG, entryFor } from './catalog';
import { DEFAULT_PREFERENCES, Preferences, insideQuietHours, nextOpenWindow, planDelivery } from './delivery';

// Every test pins the clock. An unpinned quiet-hours test passes in the morning
// and fails at night, and CI runs at all hours.
const DAYTIME = new Date('2026-08-19T10:00:00Z');
const NIGHT = new Date('2026-08-19T23:00:00Z');
const EARLY_HOURS = new Date('2026-08-19T03:00:00Z');

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
    ['21:00, the moment it starts', '2026-08-19T21:00:00Z', true],
    ['23:00, before midnight', '2026-08-19T23:00:00Z', true],
    ['03:00, after midnight', '2026-08-19T03:00:00Z', true],
    ['06:59, just before it lifts', '2026-08-19T06:59:00Z', true],
    ['07:00, the moment it lifts', '2026-08-19T07:00:00Z', false],
    ['10:00, mid-morning', '2026-08-19T10:00:00Z', false],
    ['20:59, just before it starts', '2026-08-19T20:59:00Z', false],
  ])('%s is inside=%s', (_label, iso, expected) => {
    expect(insideQuietHours(new Date(iso), window)).toBe(expected);
  });

  it('is never inside when the applicant has turned it off', () => {
    expect(insideQuietHours(NIGHT, { ...window, enabled: false })).toBe(false);
  });

  it('opens at 07:00 the same morning when it is already past midnight', () => {
    expect(nextOpenWindow(EARLY_HOURS, window).toISOString()).toBe('2026-08-19T07:00:00.000Z');
  });

  it('opens at 07:00 the NEXT morning when it is still the evening', () => {
    expect(nextOpenWindow(NIGHT, window).toISOString()).toBe('2026-08-20T07:00:00.000Z');
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
    expect(result.deferredUntil?.toISOString()).toBe('2026-08-20T07:00:00.000Z');
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
