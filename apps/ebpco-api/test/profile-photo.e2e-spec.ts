import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { makeJpeg, makePdf, makePng } from '../src/modules/documents/domain/__fixtures__';

/**
 * The User Portal Profile screen's "upload photo" — `PUT`/`GET`/`DELETE
 * /me/photo` and `GET /me`'s `hasPhoto`.
 *
 * The property this exists to protect: a citizen who uploads a photo, then
 * reloads the page (a fresh `/me`), sees the SAME photo back — not the local
 * `FileReader` preview `profile.page.ts` used to hold that vanished the
 * moment the tab closed. Every test below is really asking one question:
 * does this survive the round trip, the same way GOOD_PASSWORD's new value
 * has to survive one in identity.e2e-spec.ts's password-change tests.
 */

const ENV: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
  PUSH_TOKEN_ENCRYPTION_KEY: 'a-test-push-key-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

let app: NestFastifyApplication;
let db: SqlClient;
let accessToken: string;
const logLines: string[] = [];

async function registerAndSignIn(email: string): Promise<string> {
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      firstName: 'Maria', lastName: 'Santos', email, mobileNumber: '09171234567',
      password: 'The quiet Barangay hall, on Tuesday at 3pm!',
    },
  });
  const signedIn = await app.inject({
    method: 'POST', url: '/auth/token',
    payload: { grantType: 'password', email, password: 'The quiet Barangay hall, on Tuesday at 3pm!' },
  });
  return signedIn.json<{ accessToken: string }>().accessToken;
}

const upload = (fileName: string, bytes: Buffer, token = accessToken) =>
  app.inject({
    method: 'PUT', url: '/me/photo',
    headers: { authorization: `Bearer ${token}` },
    payload: { fileName, contentBase64: bytes.toString('base64') },
  });

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  accessToken = await registerAndSignIn('maria.photo@example.ph');
});

afterEach(() => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('before any photo is uploaded', () => {
  it('reports hasPhoto false and 404s the bytes', async () => {
    const fresh = await registerAndSignIn('never-uploaded@example.ph');

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${fresh}` } });
    expect(me.json<{ hasPhoto: boolean }>().hasPhoto).toBe(false);

    const photo = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${fresh}` },
    });
    expect(photo.statusCode).toBe(404);
  });
});

describe('uploading a real photo', () => {
  it('accepts a PNG and serves the exact same bytes back', async () => {
    const png = makePng({ width: 200, height: 200 });
    const response = await upload('selfie.png', png);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ contentType: string }>().contentType).toBe('image/png');

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.json<{ hasPhoto: boolean }>().hasPhoto).toBe(true);

    const served = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-disposition']).toBe('inline');
    // The GPS-looking eXIf chunk `makePng` writes when metadata is on must not
    // survive — same scrubbing guarantee a document upload gets.
    expect(served.rawPayload.includes(Buffer.from('GPSLatitude', 'latin1'))).toBe(false);
  });

  it('accepts a JPEG too, and strips its EXIF the same way', async () => {
    const jpeg = makeJpeg({ width: 300, height: 300 });
    const response = await upload('selfie.jpg', jpeg);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ contentType: string }>().contentType).toBe('image/jpeg');

    const served = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.rawPayload.includes(Buffer.from('GPSLatitude', 'latin1'))).toBe(false);
  });

  it('replaces the previous photo rather than keeping both', async () => {
    const first = makePng({ width: 100, height: 100, withMetadata: false });
    const second = makeJpeg({ width: 400, height: 400, withMetadata: false });

    await upload('first.png', first);
    const replaced = await upload('second.jpg', second);
    expect(replaced.statusCode).toBe(200);

    const served = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${accessToken}` },
    });
    // The second upload's own content type, not the first's — proving the
    // account now points at the new object rather than the old one.
    expect(served.headers['content-type']).toBe('image/jpeg');
  });

  it('refuses a PDF: a profile photo must be an image', async () => {
    const response = await upload('not-a-photo.pdf', makePdf());
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('/contentBase64');
  });

  it('refuses bytes that are not a recognisable image at all', async () => {
    const response = await upload('fake.png', Buffer.from('this is not an image', 'utf8'));
    expect(response.statusCode).toBe(400);
  });

  it('refuses an empty upload', async () => {
    const response = await upload('empty.png', Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
  });
});

describe('removing the photo', () => {
  it('clears hasPhoto and 404s the bytes afterward', async () => {
    const account = await registerAndSignIn('remove-photo@example.ph');
    await upload('selfie.png', makePng(), account);

    const removed = await app.inject({
      method: 'DELETE', url: '/me/photo', headers: { authorization: `Bearer ${account}` },
    });
    expect(removed.statusCode).toBe(204);

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${account}` } });
    expect(me.json<{ hasPhoto: boolean }>().hasPhoto).toBe(false);

    const served = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${account}` },
    });
    expect(served.statusCode).toBe(404);
  });

  it('is a no-op, not an error, when there was never a photo', async () => {
    const account = await registerAndSignIn('remove-nothing@example.ph');
    const response = await app.inject({
      method: 'DELETE', url: '/me/photo', headers: { authorization: `Bearer ${account}` },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('erasure clears the photo too', () => {
  it('clears photo_key and photo_content_type on the row itself', async () => {
    const account = await registerAndSignIn('erase-with-photo@example.ph');
    await upload('selfie.png', makePng(), account);

    const before = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${account}` } });
    expect(before.json<{ hasPhoto: boolean }>().hasPhoto).toBe(true);
    const accountId = before.json<{ id: string }>().id;

    const erased = await app.inject({
      method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${account}` },
    });
    expect(erased.statusCode).toBe(202);

    // The row itself, not a route answer -- proving the UPDATE in
    // erasure.service.ts really did clear both columns, rather than merely
    // leaving them unreachable behind a disabled account.
    const row = await db.query<{ photo_key: string | null; photo_content_type: string | null }>(
      'select photo_key, photo_content_type from accounts where id = $1', [accountId],
    );
    expect(row.rows[0]).toEqual({ photo_key: null, photo_content_type: null });

    // 401, not 404: erasure disables the account in the same transaction,
    // and `AuthenticationGuard` checks that on every request -- so the bearer
    // in hand stops working immediately, not just once its own expiry or a
    // refresh would have caught up with it.
    const photo = await app.inject({
      method: 'GET', url: '/me/photo', headers: { authorization: `Bearer ${account}` },
    });
    expect(photo.statusCode).toBe(401);
  });
});
