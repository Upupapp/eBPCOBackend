import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { SecretBox } from '../src/modules/identity/domain/secret-box';
import { NotificationService } from '../src/modules/notifications/application/notification.service';
import {
  MAX_PUSH_ATTEMPTS, PushDeliveryService,
} from '../src/modules/notifications/application/push-delivery.service';
import { FcmSender, PushMessage, PushOutcome } from '../src/modules/notifications/infrastructure/fcm-sender';

/**
 * Push over FCM, against a real database with a stand-in for Firebase.
 *
 * What matters here: a due attempt is actually sent and recorded as sent; a
 * token Firebase says is gone is removed so it is never tried again; a
 * transient failure is retried a bounded number of times; and a push held for
 * quiet hours is not sent before its window opens.
 */

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');
const ACCOUNT = randomUUID();
const APPLICATION = randomUUID();
const box = new SecretBox('k'.repeat(40));

let db: SqlClient;
let now: Date;

class FakeSender {
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  constructor(private readonly answer: (token: string) => PushOutcome) {}
  send(token: string, message: PushMessage): Promise<PushOutcome> {
    this.sent.push({ token, message });
    return Promise.resolve(this.answer(token));
  }
}

const service = (sender: FakeSender): PushDeliveryService =>
  new PushDeliveryService(db, box, sender as unknown as FcmSender, () => now);

async function addDevice(token: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into devices (id, account_id, platform, push_token_digest, push_token_encrypted)
     values ($1,$2,'android',$3,$4)`,
    [id, ACCOUNT, `digest-${token}`, Buffer.from(box.seal(token), 'utf8')],
  );
  return id;
}

async function notify(): Promise<void> {
  await db.query(
    `insert into notifications (id, account_id, type, title, body, application_id)
     values ($1,$2,'application-submitted','Application filed','Your application has been filed.',$3)`,
    [randomUUID(), ACCOUNT, null],
  );
  await new NotificationService(db, () => now).planPending();
}

const pushRow = async () => (await db.query<{ status: string; attempts: number; failure_detail: string | null }>(
  "select status, attempts, failure_detail from notification_deliveries where channel = 'push'",
)).rows[0]!;

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  // 13:00 in Manila — outside the default 21:00–07:00 quiet hours.
  now = new Date('2026-09-26T05:00:00Z');
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [ACCOUNT],
  );
  void APPLICATION;
});

afterEach(async () => {
  await db.close();
});

describe('push delivery', () => {
  it('sends a due push to the registered handset and records it as sent', async () => {
    await addDevice('token-A');
    await notify();
    const sender = new FakeSender(() => ({ ok: true }));

    const summary = await service(sender).sendDue();

    expect(summary.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.token).toBe('token-A');
    expect(sender.sent[0]!.message.title).toBe('Application filed');
    expect(sender.sent[0]!.message.data.type).toBe('application-submitted');
    expect((await pushRow()).status).toBe('sent');

    // Sent once: a second run finds nothing due.
    await service(sender).sendDue();
    expect(sender.sent).toHaveLength(1);
  });

  it('removes a handset Firebase reports as gone and does not try it again', async () => {
    await addDevice('stale');
    await notify();
    const sender = new FakeSender(() => ({ ok: false, gone: true, detail: 'HTTP 404 UNREGISTERED' }));

    const summary = await service(sender).sendDue();

    expect(summary.prunedDevices).toBe(1);
    expect((await db.query('select id from devices')).rows).toHaveLength(0);
    const row = await pushRow();
    expect(row.status).toBe('failed');
    expect(row.failure_detail).toContain('UNREGISTERED');
  });

  it('retries a transient failure, then gives up after the limit', async () => {
    await addDevice('token-A');
    await notify();
    const sender = new FakeSender(() => ({ ok: false, gone: false, detail: 'HTTP 503 UNAVAILABLE' }));

    await service(sender).sendDue();
    expect(await pushRow()).toMatchObject({ status: 'queued', attempts: 1 });

    for (let i = 1; i < MAX_PUSH_ATTEMPTS; i += 1) await service(sender).sendDue();
    expect(await pushRow()).toMatchObject({ status: 'failed', attempts: MAX_PUSH_ATTEMPTS });
    expect(sender.sent).toHaveLength(MAX_PUSH_ATTEMPTS);
  });

  it('holds a quiet-hours push until its window opens', async () => {
    await addDevice('token-A');
    // 23:00 in Manila: inside quiet hours, so the push is deferred to 07:00.
    now = new Date('2026-09-26T15:00:00Z');
    await notify();
    const sender = new FakeSender(() => ({ ok: true }));

    await service(sender).sendDue();
    expect(sender.sent).toHaveLength(0);
    expect((await pushRow()).status).toBe('deferred');

    // 07:30 Manila the next morning.
    now = new Date('2026-09-26T23:30:00Z');
    await service(sender).sendDue();
    expect(sender.sent).toHaveLength(1);
    expect((await pushRow()).status).toBe('sent');
  });

  it('prunes a device whose stored token cannot be opened', async () => {
    await db.query(
      `insert into devices (account_id, platform, push_token_digest, push_token_encrypted)
       values ($1,'android','digest-plain',$2)`,
      [ACCOUNT, Buffer.from('raw-token-from-before-encryption', 'utf8')],
    );
    await notify();
    const sender = new FakeSender(() => ({ ok: true }));

    const summary = await service(sender).sendDue();

    expect(sender.sent).toHaveLength(0);
    expect(summary.prunedDevices).toBe(1);
    expect((await pushRow()).status).toBe('failed');
  });

  it('does nothing when FCM is not configured', async () => {
    await addDevice('token-A');
    await notify();
    const push = new PushDeliveryService(db, box, null, () => now);

    expect(push.configured).toBe(false);
    expect(await push.sendDue()).toEqual({ sent: 0, retrying: 0, failed: 0, prunedDevices: 0 });
    expect((await pushRow()).status).toBe('queued');
  });
});

describe('the FCM sender', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    project_id: 'castilla-ebpco',
    client_email: 'sender@castilla-ebpco.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };

  type Call = { url: string; body: string; headers: Record<string, string> };
  const fakeFetch = (calls: Call[], messageAnswer: { status: number; body: unknown }) =>
    (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, body: init.body, headers: init.headers });
      const isToken = url.includes('oauth2');
      const status = isToken ? 200 : messageAnswer.status;
      const body = isToken ? { access_token: 'access-1', expires_in: 3600 } : messageAnswer.body;
      return Promise.resolve({
        ok: status >= 200 && status < 300, status,
        json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
      });
    };

  it('signs in with the service account once and sends to the device token', async () => {
    const calls: Call[] = [];
    const sender = new FcmSender(account, fakeFetch(calls, { status: 200, body: { name: 'm1' } }));

    expect(await sender.send('device-token', { title: 'T', body: 'B', data: { applicationId: 'a1' } }))
      .toEqual({ ok: true });
    await sender.send('device-token', { title: 'T2', body: 'B2', data: {} });

    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const message = calls.find((c) => c.url.includes('/messages:send'))!;
    expect(message.url).toBe('https://fcm.googleapis.com/v1/projects/castilla-ebpco/messages:send');
    expect(message.headers.authorization).toBe('Bearer access-1');
    expect(JSON.parse(message.body)).toMatchObject({
      message: { token: 'device-token', notification: { title: 'T', body: 'B' }, data: { applicationId: 'a1' } },
    });
  });

  it('reports an unregistered token as gone', async () => {
    const sender = new FcmSender(account, fakeFetch([], {
      status: 404,
      body: { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } },
    }));

    const outcome = await sender.send('old', { title: 'T', body: 'B', data: {} });
    expect(outcome).toMatchObject({ ok: false, gone: true });
  });

  it('treats a server error as retryable, not gone', async () => {
    const sender = new FcmSender(account, fakeFetch([], { status: 503, body: { error: { status: 'UNAVAILABLE' } } }));
    expect(await sender.send('t', { title: 'T', body: 'B', data: {} })).toMatchObject({ ok: false, gone: false });
  });

  it('reads the service account from base64 and refuses a malformed one', () => {
    expect(FcmSender.fromBase64('')).toBeNull();
    expect(FcmSender.fromBase64(Buffer.from(JSON.stringify(account)).toString('base64'))!.projectId)
      .toBe('castilla-ebpco');
    expect(() => FcmSender.fromBase64(Buffer.from('{"project_id":"x"}').toString('base64'))).toThrow();
  });
});
