import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Signed document URLs, independent of where the bytes live.
 *
 * These are HMAC tokens **the API redeems itself**, not links a browser fetches
 * from a bucket. That is the decision this file exists to keep: expiry and
 * authorisation stay in the service, where they hold whichever store is behind
 * them, and the bytes pass through a place that can verify them against the
 * checksum recorded at upload.
 *
 * A bucket's own presigned URL would move all three of those out of reach --
 * and, with Linode Object Storage or any S3-compatible provider, would hand a
 * browser a link straight to storage where this service can no longer say who
 * is allowed to follow it.
 *
 * Shared rather than reimplemented per store. Two stores signing "the same way"
 * is a claim that stops being true silently; one function is a claim that
 * cannot.
 */

export type SignedUrlVerdict = 'ok' | 'expired' | 'invalid';

export function signObjectUrl(
  signingKey: string, key: string, expiresInSeconds: number, now: Date,
): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + expiresInSeconds;
  // A nonce, so the same key issued twice produces two distinct URLs and one
  // cannot be mistaken for a stable address.
  const nonce = randomUUID();
  const signature = signature_(signingKey, key, expiresAt, nonce);
  return `/documents/content?key=${encodeURIComponent(key)}`
    + `&expires=${expiresAt}&n=${nonce}&sig=${signature}`;
}

export function verifyObjectUrl(
  signingKey: string, key: string, expiresAt: number, nonce: string,
  presented: string, now: Date,
): SignedUrlVerdict {
  // Constant-time. A `!==` on an HMAC leaks, through timing, how many leading
  // bytes of a guess were right -- which is the one thing that turns forging a
  // 256-bit signature from impossible into a search.
  const expected = Buffer.from(signature_(signingKey, key, expiresAt, nonce), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  if (expected.length !== given.length) return 'invalid';
  if (!timingSafeEqual(expected, given)) return 'invalid';

  // Checked AFTER the signature, deliberately: answering 'expired' to an
  // unsigned guess would confirm that the key exists.
  if (expiresAt * 1000 <= now.getTime()) return 'expired';
  return 'ok';
}

function signature_(signingKey: string, key: string, expiresAt: number, nonce: string): string {
  return createHmac('sha256', signingKey)
    .update(`${key}:${expiresAt}:${nonce}`)
    .digest('base64url');
}
