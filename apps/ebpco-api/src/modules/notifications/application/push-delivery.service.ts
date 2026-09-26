import { SqlClient } from '../../../persistence/sql-client';
import { SecretBox } from '../../identity/domain/secret-box';
import { FcmSender, PushMessage } from '../infrastructure/fcm-sender';

/**
 * Sends the push attempts `NotificationService.planPending` recorded.
 *
 * Due means `queued`, or `deferred` whose quiet-hours window has opened. Each
 * attempt goes to every device the account has registered; one handset
 * receiving it is a delivery. A token FCM reports as gone is pruned on the spot,
 * so an uninstalled app stops being tried. Transient failures are retried on
 * later runs up to `MAX_ATTEMPTS`, then marked failed with the reason — the feed
 * entry and the email record of notice exist regardless.
 */

export const MAX_PUSH_ATTEMPTS = 5;

export interface PushRunSummary {
  readonly sent: number;
  readonly retrying: number;
  readonly failed: number;
  readonly prunedDevices: number;
}

export class PushDeliveryService {
  constructor(
    private readonly db: SqlClient,
    private readonly tokens: SecretBox,
    private readonly sender: FcmSender | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get configured(): boolean {
    return this.sender !== null;
  }

  async sendDue(limit = 100): Promise<PushRunSummary> {
    const summary = { sent: 0, retrying: 0, failed: 0, prunedDevices: 0 };
    if (this.sender === null) return summary;
    const now = this.clock();

    const due = await this.db.query<{
      id: string; attempts: number; notification_id: string; account_id: string;
      type: string; title: string; body: string; application_id: string | null;
    }>(
      `select d.id, d.attempts, n.id as notification_id, n.account_id, n.type, n.title, n.body, n.application_id
         from notification_deliveries d
         join notifications n on n.id = d.notification_id
        where d.channel = 'push'
          and (d.status = 'queued' or (d.status = 'deferred' and d.deferred_until <= $1))
        order by n.created_at
        limit $2`,
      [now, limit],
    );

    for (const row of due.rows) {
      const devices = await this.db.query<{ id: string; push_token_encrypted: Uint8Array }>(
        'select id, push_token_encrypted from devices where account_id = $1',
        [row.account_id],
      );

      const message: PushMessage = {
        title: row.title,
        body: row.body,
        data: {
          notificationId: row.notification_id,
          type: row.type,
          ...(row.application_id === null ? {} : { applicationId: row.application_id }),
        },
      };

      let delivered = false;
      let lastFailure = devices.rows.length === 0 ? 'no device is registered any more' : '';
      let reachable = 0;

      for (const device of devices.rows) {
        // bytea arrives as a Buffer from pg and a Uint8Array from PGlite.
        const token = this.tokens.open(Buffer.from(device.push_token_encrypted).toString('utf8'));
        if (token === null) {
          // Written before tokens were encrypted, or under another key. It can
          // never be opened again; the handset re-registers on its next launch.
          await this.db.query('delete from devices where id = $1', [device.id]);
          summary.prunedDevices += 1;
          continue;
        }
        const outcome = await this.sender.send(token, message);
        if (outcome.ok) {
          delivered = true;
          reachable += 1;
        } else if (outcome.gone) {
          await this.db.query('delete from devices where id = $1', [device.id]);
          summary.prunedDevices += 1;
          lastFailure = outcome.detail;
        } else {
          reachable += 1;
          lastFailure = outcome.detail;
        }
      }

      const attempts = row.attempts + 1;
      if (delivered) {
        await this.db.query(
          `update notification_deliveries
              set status = 'sent', attempted_at = $2, attempts = $3, failure_detail = null
            where id = $1`,
          [row.id, now, attempts],
        );
        summary.sent += 1;
      } else if (reachable === 0 || attempts >= MAX_PUSH_ATTEMPTS) {
        await this.db.query(
          `update notification_deliveries
              set status = 'failed', attempted_at = $2, attempts = $3, failure_detail = $4
            where id = $1`,
          [row.id, now, attempts, lastFailure.slice(0, 300)],
        );
        summary.failed += 1;
      } else {
        await this.db.query(
          `update notification_deliveries
              set status = 'queued', attempted_at = $2, attempts = $3, failure_detail = $4
            where id = $1`,
          [row.id, now, attempts, lastFailure.slice(0, 300)],
        );
        summary.retrying += 1;
      }
    }

    return summary;
  }
}
