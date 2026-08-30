import { createHash, randomBytes } from 'node:crypto';

/**
 * Where document bytes live. Never the database: permit attachments are large,
 * numerous, and personal data.
 */
export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<boolean>;
  /**
   * A short-lived, single-purpose URL. Never a permanent link, and issued only
   * after the caller's right to the parent application has been checked.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /**
   * Checks a signed URL's parameters.
   *
   * On the port because the API redeems these itself rather than handing out
   * bucket links — see FilesystemObjectStore. A store whose URLs are redeemed
   * elsewhere would answer 'ok' here and let the route's own checks stand.
   */
  verifySignedUrl(key: string, expiresAt: number, nonce: string, signature: string): 'ok' | 'expired' | 'invalid';
  /**
   * Whether the bucket is reachable without credentials. Checked on every
   * deploy: a public bucket of applicants' identity documents is the worst
   * single failure this system can have, and it is a configuration mistake
   * rather than a code one, so code cannot prevent it — only detect it.
   */
  isPubliclyReadable(): Promise<boolean>;
}

/**
 * Object keys are opaque and non-enumerable.
 *
 * Not `applications/<id>/tct.pdf`: a key that encodes the application and the
 * document name lets anyone who obtains one URL guess at others, and lets
 * anyone who sees a key learn what the document is. 128 bits of randomness,
 * shaded into two levels so a bucket listing does not become one flat directory
 * of a million objects.
 */
export function newObjectKey(): string {
  const raw = randomBytes(16).toString('hex');
  return `${raw.slice(0, 2)}/${raw.slice(2, 4)}/${raw.slice(4)}`;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
