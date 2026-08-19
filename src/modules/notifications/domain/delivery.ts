import { CatalogEntry, NotificationCategory } from './catalog';

/**
 * Which channels a notification goes out on, and when.
 *
 * Pure, so quiet hours and muting can be asserted without a clock or a network.
 *
 * ── Decision E-9: the escalation channel ────────────────────────────────
 *
 * Push is a convenience, never the record. A push to an uninstalled app reaches
 * nobody, and the LGU may need to prove it gave notice — RA 11032 processing
 * periods run against notices the applicant is assumed to have received.
 *
 * So: **email for every notification**, as the record of notice. It is cheap,
 * archivable, provable, and the address is already verified at registration.
 * **SMS additionally for statutory notices** — the ones that start a clock the
 * applicant can miss. The mobile number is already verified under ADR 0004's
 * tier 1, so this needs no new identity proofing, only a provider.
 *
 * See docs/decisions/0011-escalation-channel.md.
 */

export type Channel = 'push' | 'email' | 'sms';

export interface QuietHours {
  readonly enabled: boolean;
  /** 'HH:MM', local Philippine time. */
  readonly start: string;
  readonly end: string;
}

export interface Preferences {
  readonly mutedCategories: readonly NotificationCategory[];
  readonly quietHours: QuietHours;
}

export const DEFAULT_PREFERENCES: Preferences = {
  mutedCategories: [],
  quietHours: { enabled: true, start: '21:00', end: '07:00' },
};

export interface DeliveryPlan {
  /** Sent now. */
  readonly immediate: readonly Channel[];
  /** Held until `deferredUntil`, never dropped. */
  readonly deferred: readonly Channel[];
  readonly deferredUntil: Date | null;
  /** Suppressed by the applicant's own choice. The feed entry is still written. */
  readonly suppressed: readonly Channel[];
  readonly reasons: Readonly<Record<string, string>>;
}

/** Minutes since midnight, for a 'HH:MM' string. */
function minutesOf(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Quiet hours wrap midnight (21:00–07:00), so "inside" is not a simple
 * comparison. Getting this wrong the obvious way means every push between
 * midnight and 07:00 is sent.
 */
export function insideQuietHours(at: Date, quietHours: QuietHours): boolean {
  if (!quietHours.enabled) return false;

  const now = at.getUTCHours() * 60 + at.getUTCMinutes();
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);

  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** The next moment the window opens. */
export function nextOpenWindow(at: Date, quietHours: QuietHours): Date {
  const end = minutesOf(quietHours.end);
  const opens = new Date(at);
  opens.setUTCHours(Math.floor(end / 60), end % 60, 0, 0);
  if (opens.getTime() <= at.getTime()) opens.setUTCDate(opens.getUTCDate() + 1);
  return opens;
}

export function planDelivery(options: {
  entry: CatalogEntry;
  preferences: Preferences;
  now: Date;
  hasDevice: boolean;
}): DeliveryPlan {
  const { entry, preferences, now, hasDevice } = options;

  const immediate: Channel[] = [];
  const deferred: Channel[] = [];
  const suppressed: Channel[] = [];
  const reasons: Record<string, string> = {};

  // ── email ────────────────────────────────────────────────────────────
  // Always. It is the record of notice, and it makes no noise, so quiet hours
  // do not apply to it.
  immediate.push('email');

  // ── push ─────────────────────────────────────────────────────────────
  const muted = preferences.mutedCategories.includes(entry.category);
  if (!hasDevice) {
    suppressed.push('push');
    reasons.push = 'no device is registered';
  } else if (muted) {
    // A mute always silences the push, including for a statutory notice. The
    // mute is a preference about THIS channel, and carving out an exception
    // would make the setting a lie for half the catalog — the applicant would
    // turn it off and still be buzzed.
    //
    // The notice still arrives: email always, and SMS for anything statutory.
    // The feed entry is written either way, because the LGU must be able to
    // show it told them.
    suppressed.push('push');
    reasons.push = entry.statutory
      ? `the ${entry.category} category is muted; this notice is still being sent by email and SMS`
      : `the ${entry.category} category is muted`;
  } else if (insideQuietHours(now, preferences.quietHours)) {
    // Deferred, never dropped. A notice that would have arrived at 23:00 is
    // still a notice.
    deferred.push('push');
    reasons.push = 'inside quiet hours; will be delivered at the next open window';
  } else {
    immediate.push('push');
  }

  // ── sms ──────────────────────────────────────────────────────────────
  // Only for notices that start a clock the applicant can miss, and never
  // muteable: a mute is a preference about noise, not a waiver of notice.
  if (entry.statutory) {
    if (insideQuietHours(now, preferences.quietHours)) {
      deferred.push('sms');
      reasons.sms = 'inside quiet hours; will be delivered at the next open window';
    } else {
      immediate.push('sms');
    }
    if (muted) {
      // Stated explicitly so nobody later "fixes" SMS to respect the mute: the
      // mute governs push, and a notice with a statutory consequence is not
      // something an applicant can switch off by preference.
      reasons.smsMuteIgnored =
        'this notice carries a statutory consequence, so muting suppresses the push but not the notice itself';
    }
  }

  return {
    immediate,
    deferred,
    deferredUntil: deferred.length > 0 ? nextOpenWindow(now, preferences.quietHours) : null,
    suppressed,
    reasons,
  };
}
