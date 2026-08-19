import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { Scope } from './account';

/**
 * Access tokens are short-lived and stateless. Refresh tokens are long-lived,
 * opaque, stored only as a digest, and rotate on every use.
 *
 * The asymmetry is deliberate. Checking a revocation list on every request
 * would put the database in the path of every call; instead the access token's
 * fifteen-minute life bounds how long a revoked session keeps working, and
 * revocation takes effect on the refresh, which must reach the database anyway.
 * That bound is the security property, and it is why the lifetime is a ceiling
 * rather than a preference.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes, the stated ceiling
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface AccessTokenClaims {
  /** Account id. */
  readonly sub: string;
  /** Session (refresh-token family) id, so a token can be traced to a sign-in. */
  readonly sid: string;
  readonly kind: 'applicant' | 'staff';
  readonly scopes: readonly Scope[];
}

/**
 * A refresh token as the client sees it: an opaque secret plus the id of the
 * row that holds its digest.
 *
 * Presented as `<id>.<secret>` so a lookup does not require scanning every
 * stored digest -- and so a stolen token cannot be tested against other
 * accounts' rows.
 */
export interface IssuedRefreshToken {
  readonly id: string;
  readonly familyId: string;
  /**
   * Carried on the result rather than looked up separately: the store already
   * knows it, and a second copy held anywhere else is a copy that can disagree.
   */
  readonly accountId: string;
  readonly presented: string;
  readonly expiresAt: Date;
}

/** The stored half. The secret itself is never persisted. */
export interface StoredRefreshToken {
  readonly id: string;
  readonly familyId: string;
  readonly accountId: string;
  readonly secretDigest: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Set when this token has been exchanged. A second exchange is a replay. */
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

const SECRET_BYTES = 32;

export function mintRefreshSecret(): { secret: string; digest: string } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, digest: digestRefreshSecret(secret) };
}

/**
 * SHA-256, not scrypt.
 *
 * A refresh secret is 256 bits of entropy from a CSPRNG, so there is no
 * dictionary to attack and no work factor to impose -- unlike a password,
 * which is low-entropy and human-chosen. Using a memory-hard hash here would
 * cost 64 MiB on every token refresh and buy nothing.
 */
export function digestRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export function refreshSecretMatches(secret: string, digest: string): boolean {
  const candidate = Buffer.from(digestRefreshSecret(secret), 'utf8');
  const stored = Buffer.from(digest, 'utf8');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function formatRefreshToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseRefreshToken(presented: string): { id: string; secret: string } | null {
  const separator = presented.indexOf('.');
  if (separator <= 0 || separator === presented.length - 1) return null;
  return {
    id: presented.slice(0, separator),
    secret: presented.slice(separator + 1),
  };
}
