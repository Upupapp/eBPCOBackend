import { SqlClient } from '../../../persistence/sql-client';
import { NotificationCategory, entryFor } from '../domain/catalog';
import { Channel, DEFAULT_PREFERENCES, Preferences, planDelivery } from '../domain/delivery';

/**
 * The applicant's feed, their preferences, and the outbox that drains it.
 *
 * The distinction this class exists to hold: **`readAt` and `resolvedAt` are
 * different things.** Opening a notification does not discharge the action it
 * describes. The badge counts unresolved actions, not unread items — an
 * applicant who reads "revision required" and does nothing still owes an act,
 * and a badge that cleared on read would tell them otherwise.
 */

export interface FeedEntry {
  readonly id: string;
  readonly type: string;
  readonly category: NotificationCategory;
  readonly applicationId: string | null;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly requiresAction: boolean;
}

export interface Feed {
  readonly entries: readonly FeedEntry[];
  /** What the tab badge shows. Unresolved actions, never unread items. */
  readonly unresolvedCount: number;
}

export interface DeliveryAttempt {
  readonly notificationId: string;
  readonly channel: Channel;
  readonly deferredUntil: Date | null;
}

export class NotificationService {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async feed(accountId: string, limit = 50): Promise<Feed> {
    const rows = await this.db.query<{
      id: string; type: string; application_id: string | null;
      title: string; body: string; deep_link: string | null;
      created_at: Date; read_at: Date | null; resolved_at: Date | null;
    }>(
      `select id, type, application_id, title, body, deep_link, created_at, read_at, resolved_at
         from notifications where account_id = $1
        order by created_at desc limit $2`,
      [accountId, limit],
    );

    const entries = rows.rows.map((row): FeedEntry => {
      const entry = entryFor(row.type);
      return {
        id: row.id,
        type: row.type,
        category: entry?.category ?? 'applicationUpdates',
        applicationId: row.application_id,
        title: row.title,
        body: row.body,
        deepLink: row.deep_link,
        createdAt: row.created_at,
        readAt: row.read_at,
        resolvedAt: row.resolved_at,
        requiresAction: entry?.requiresAction ?? false,
      };
    });

    const unresolved = await this.db.query<{ count: number }>(
      `select count(*)::int as count from notifications n
         join notification_types t on t.type = n.type
        where n.account_id = $1 and n.resolved_at is null and t.requires_action`,
      [accountId],
    );

    return { entries, unresolvedCount: unresolved.rows[0]?.count ?? 0 };
  }

  /**
   * Stamps `readAt` and nothing else.
   *
   * Deliberately cannot resolve. If reading could discharge an action, an
   * applicant glancing at a list would clear their own outstanding obligations
   * without doing any of them.
   */
  async markRead(notificationId: string, accountId: string): Promise<boolean> {
    const updated = await this.db.query(
      `update notifications set read_at = coalesce(read_at, $1)
        where id = $2 and account_id = $3`,
      [this.clock(), notificationId, accountId],
    );
    return updated.rowCount > 0;
  }

  /**
   * Stamps `resolvedAt`. Called when the underlying act is done, not when the
   * applicant looks at it.
   */
  async markResolved(notificationId: string, accountId: string): Promise<boolean> {
    const updated = await this.db.query(
      `update notifications set resolved_at = coalesce(resolved_at, $1)
        where id = $2 and account_id = $3`,
      [this.clock(), notificationId, accountId],
    );
    return updated.rowCount > 0;
  }

  async preferences(accountId: string): Promise<Preferences> {
    const row = await this.db.query<{
      muted_categories: string[]; quiet_hours_enabled: boolean;
      quiet_hours_start: string; quiet_hours_end: string;
    }>(
      `select muted_categories, quiet_hours_enabled, quiet_hours_start, quiet_hours_end
         from notification_preferences where account_id = $1`,
      [accountId],
    );
    const found = row.rows[0];
    if (found === undefined) return DEFAULT_PREFERENCES;

    return {
      mutedCategories: found.muted_categories as NotificationCategory[],
      quietHours: {
        enabled: found.quiet_hours_enabled,
        start: found.quiet_hours_start.slice(0, 5),
        end: found.quiet_hours_end.slice(0, 5),
      },
    };
  }

  async replacePreferences(accountId: string, preferences: Preferences): Promise<void> {
    await this.db.query(
      `insert into notification_preferences
         (account_id, muted_categories, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, updated_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id) do update set
         muted_categories    = excluded.muted_categories,
         quiet_hours_enabled = excluded.quiet_hours_enabled,
         quiet_hours_start   = excluded.quiet_hours_start,
         quiet_hours_end     = excluded.quiet_hours_end,
         updated_at          = excluded.updated_at`,
      [accountId, preferences.mutedCategories, preferences.quietHours.enabled,
       preferences.quietHours.start, preferences.quietHours.end, this.clock()],
    );
  }

  /**
   * Drains the outbox.
   *
   * The notification rows were committed in the same transaction as the status
   * change that produced them (TAB 05), so anything here is a thing that
   * definitely happened. Delivery is decided per notification against the
   * applicant's own preferences and the clock.
   *
   * Returns the plan rather than performing it: FCM, APNs, SMTP and an SMS
   * provider are all external, and TAB 15 owns their retry and backoff. What is
   * settled here is WHO gets told WHAT over WHICH channel and WHEN — the part
   * that has to be right regardless of which vendor sends it.
   */
  async planPending(limit = 100): Promise<DeliveryAttempt[]> {
    const pending = await this.db.query<{
      id: string; type: string; account_id: string; has_device: boolean;
    }>(
      `select n.id, n.type, n.account_id,
              exists (select 1 from devices d where d.account_id = n.account_id) as has_device
         from notifications n
        where n.dispatched_at is null
        order by n.created_at
        limit $1`,
      [limit],
    );

    const attempts: DeliveryAttempt[] = [];
    const now = this.clock();

    for (const row of pending.rows) {
      const entry = entryFor(row.type);
      if (entry === undefined) continue;

      const preferences = await this.preferences(row.account_id);
      const plan = planDelivery({ entry, preferences, now, hasDevice: row.has_device });

      for (const channel of plan.immediate) {
        attempts.push({ notificationId: row.id, channel, deferredUntil: null });
      }
      for (const channel of plan.deferred) {
        attempts.push({ notificationId: row.id, channel, deferredUntil: plan.deferredUntil });
      }

      // Marked dispatched only once a plan exists for it. A crash before this
      // leaves the row pending and it is planned again — at-least-once, which
      // for a notice is the right side to err on.
      await this.db.query(
        'update notifications set dispatched_at = $1 where id = $2',
        [now, row.id],
      );
    }

    return attempts;
  }

  async registerDevice(options: {
    accountId: string; platform: 'android' | 'ios'; pushTokenDigest: string;
    pushTokenEncrypted: Buffer; appVersion?: string; locale?: string;
  }): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `insert into devices (account_id, platform, push_token_digest, push_token_encrypted, app_version, locale)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (account_id, push_token_digest) do update set
         last_seen_at = now(), app_version = excluded.app_version, locale = excluded.locale
       returning id`,
      [options.accountId, options.platform, options.pushTokenDigest, options.pushTokenEncrypted,
       options.appVersion ?? null, options.locale ?? null],
    );
    return result.rows[0]?.id ?? '';
  }

  /** Removes a token the push provider reported as gone. */
  async pruneDevice(deviceId: string): Promise<boolean> {
    const removed = await this.db.query('delete from devices where id = $1', [deviceId]);
    return removed.rowCount > 0;
  }
}
