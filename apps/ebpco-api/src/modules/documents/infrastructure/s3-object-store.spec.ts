import { S3Client } from '@aws-sdk/client-s3';

import { FilesystemObjectStore } from './filesystem-object-store';
import { S3ObjectStore } from './s3-object-store';
import { ObjectStore, newObjectKey } from '../domain/object-store';
import { objectStoreFor } from '../documents.module';
import { AppConfig } from '../../../config/app-config';

/**
 * The S3 store, against a fake S3.
 *
 * **The wire path is NOT verified here.** There is no S3-compatible server on
 * this machine, so `send` is answered by an in-memory double: this proves the
 * commands are built correctly, the not-found handling is right, and that both
 * stores behave identically through the port. It does not prove the SDK talks
 * to Linode Object Storage. That needs a real bucket, and saying so is cheaper
 * than implying otherwise -- the same position the migration runner was in
 * until `pglite-socket` made its wire path testable.
 */

interface Sent { name: string; input: Record<string, unknown> }

class FakeS3 {
  readonly objects = new Map<string, { body: Buffer; contentType?: string }>();
  readonly sent: Sent[] = [];
  /** Set to make the next send throw, so error handling can be exercised. */
  failWith: Error | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<unknown> {
    const name = command.constructor.name as string;
    const input = command.input as Record<string, unknown>;
    this.sent.push({ name, input });

    if (this.failWith !== null) {
      const error = this.failWith;
      this.failWith = null;
      return Promise.reject(error);
    }

    const key = typeof input['Key'] === 'string' ? input['Key'] : '';
    if (name === 'PutObjectCommand') {
      this.objects.set(key, {
        body: input['Body'] as Buffer,
        contentType: input['ContentType'] as string,
      });
      return Promise.resolve({});
    }
    if (name === 'GetObjectCommand') {
      const found = this.objects.get(key);
      if (found === undefined) return Promise.reject(notFound());
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(found.body)) },
      });
    }
    if (name === 'DeleteObjectCommand') {
      if (!this.objects.has(key)) return Promise.reject(notFound());
      this.objects.delete(key);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  }
}

function notFound(): Error {
  const error = new Error('NoSuchKey');
  error.name = 'NoSuchKey';
  return error;
}

const SIGNING_KEY = 'a-signing-key-of-at-least-thirty-two-chars';
const NOW = new Date('2026-08-30T09:00:00+08:00');

const build = (fake = new FakeS3()): { store: S3ObjectStore; fake: FakeS3 } => ({
  store: new S3ObjectStore(
    fake as unknown as S3Client, 'ebpco-documents', SIGNING_KEY, null, () => NOW,
  ),
  fake,
});

describe('storing and retrieving', () => {
  it('round-trips bytes, and records the content type as object metadata', async () => {
    const { store, fake } = build();
    const key = newObjectKey();

    await store.put(key, Buffer.from('a land title'), 'application/pdf');

    expect(await store.get(key)).toEqual(Buffer.from('a land title'));
    const put = fake.sent.find((s) => s.name === 'PutObjectCommand');
    expect(put?.input['ContentType']).toBe('application/pdf');
    // Asked for explicitly rather than left to a bucket default, because a
    // bucket default is a setting someone can turn off with no code changing.
    expect(put?.input['ServerSideEncryption']).toBe('AES256');
  });

  it('answers null for an object that is not there', async () => {
    const { store } = build();

    expect(await store.get(newObjectKey())).toBeNull();
  });

  it('does NOT answer null when the store itself failed', async () => {
    // The distinction that matters. A credential or network failure reported as
    // "no such document" looks to an applicant exactly like their upload having
    // vanished, and to an officer like a document that was never sent.
    const { store, fake } = build();
    fake.failWith = Object.assign(new Error('credentials expired'), { name: 'CredentialsError' });

    await expect(store.get(newObjectKey())).rejects.toThrow(/credentials/);
  });

  it('reports whether a delete removed anything', async () => {
    const { store } = build();
    const key = newObjectKey();
    await store.put(key, Buffer.from('x'), 'application/pdf');

    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
  });
});

describe('the public-readability probe', () => {
  const probing = (respond: () => Promise<Response>): S3ObjectStore =>
    new S3ObjectStore(
      new FakeS3() as unknown as S3Client, 'ebpco-documents', SIGNING_KEY,
      'https://objects.example', () => NOW, respond,
    );

  it('reports a bucket that refuses a stranger as not public', async () => {
    const store = probing(() => Promise.resolve(new Response('', { status: 403 })));

    expect(await store.isPubliclyReadable()).toBe(false);
  });

  it('reports a bucket that answers a stranger as public', async () => {
    const store = probing(() => Promise.resolve(new Response('<ListBucketResult/>', { status: 200 })));

    expect(await store.isPubliclyReadable()).toBe(true);
  });

  it('answers TRUE when it cannot tell', async () => {
    // The safe reading of "I do not know whether applicants' identity documents
    // are world-readable" is not "they are fine".
    const store = probing(() => Promise.reject(new Error('network unreachable')));

    expect(await store.isPubliclyReadable()).toBe(true);
  });

  it('answers TRUE when no probe URL is configured, rather than assuming safety', async () => {
    const { store } = build();

    expect(await store.isPubliclyReadable()).toBe(true);
  });
});

describe('both stores behave the same way through the port', () => {
  // The parity that matters: the service is written against `ObjectStore`, and
  // a difference between the two shows up as behaviour that changes when the
  // driver does -- which is the hardest kind of bug to attribute.
  const cases: ReadonlyArray<readonly [string, () => ObjectStore]> = [
    ['filesystem', () => new FilesystemObjectStore(
      `${process.env['TMPDIR'] ?? '/tmp'}/ebpco-parity-${Math.random().toString(36).slice(2)}`,
      SIGNING_KEY, () => NOW,
    )],
    ['s3', () => build().store],
  ];

  it.each(cases)('%s: issues a signed URL this store then accepts', async (_name, make) => {
    const store = make();
    const key = newObjectKey();

    const url = await store.signedUrl(key, 300);
    const params = new URLSearchParams(url.split('?')[1]);

    expect(store.verifySignedUrl(
      key, Number(params.get('expires')), params.get('n')!, params.get('sig')!,
    )).toBe('ok');
  });

  it.each(cases)('%s: refuses a tampered signature', async (_name, make) => {
    const store = make();
    const key = newObjectKey();
    const params = new URLSearchParams((await store.signedUrl(key, 300)).split('?')[1]);

    expect(store.verifySignedUrl(
      key, Number(params.get('expires')), params.get('n')!, 'not-the-signature',
    )).toBe('invalid');
  });

  it.each(cases)('%s: refuses a URL signed for a different key', async (_name, make) => {
    const store = make();
    const params = new URLSearchParams((await store.signedUrl(newObjectKey(), 300)).split('?')[1]);

    expect(store.verifySignedUrl(
      newObjectKey(), Number(params.get('expires')), params.get('n')!, params.get('sig')!,
    )).toBe('invalid');
  });

  it.each(cases)('%s: round-trips bytes', async (_name, make) => {
    const store = make();
    const key = newObjectKey();

    await store.put(key, Buffer.from('the same bytes'), 'application/pdf');

    expect(await store.get(key)).toEqual(Buffer.from('the same bytes'));
  });
});

describe('which store the service actually runs on', () => {
  // The break-check that found this gap: pointing the composition root at the
  // filesystem store while the driver said `s3` passed the entire suite,
  // because nothing observed the choice. Wiring nothing can see is how a
  // configured S3 bucket ends up unused in production.
  const config = (driver: 'filesystem' | 's3'): AppConfig => ({
    OBJECT_STORE_DRIVER: driver,
    OBJECT_STORE_ENDPOINT: 'https://ap-south-1.linodeobjects.com',
    OBJECT_STORE_BUCKET: 'ebpco-documents',
    OBJECT_STORE_REGION: 'ap-south-1',
    OBJECT_STORE_PUBLIC_PROBE_URL: '',
    OBJECT_STORE_LOCAL_PATH: '.data/objects',
    JWT_SIGNING_KEY: SIGNING_KEY,
  } as unknown as AppConfig);

  it('builds the S3 store when the driver says s3', () => {
    expect(objectStoreFor(config('s3'))).toBeInstanceOf(S3ObjectStore);
  });

  it('builds the filesystem store otherwise', () => {
    expect(objectStoreFor(config('filesystem'))).toBeInstanceOf(FilesystemObjectStore);
  });
});
