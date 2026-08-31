import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';

import { Injectable, SetMetadata } from '@nestjs/common';

/**
 * How long each kind of content may be considered fresh.
 *
 * Stated per resource rather than globally, because the shapes genuinely
 * differ. An office head changes once in a term; an announcement is the one
 * content type whose whole value is timeliness, and is therefore the one most
 * likely to be over-cached by a sensible-looking default.
 */
export interface CachePolicy {
  readonly maxAge: number;
  readonly staleWhileRevalidate: number;
}

export const POLICIES = {
  /** Offices, permits, forms, pages, the municipality profile. */
  reference: { maxAge: 300, staleWhileRevalidate: 3600 },
  /** Announcements. Deliberately short: a notice nobody sees is not a notice. */
  timely: { maxAge: 30, staleWhileRevalidate: 60 },
  /** Search results — cheap to recompute, and a stale result reads as a bug. */
  query: { maxAge: 60, staleWhileRevalidate: 300 },
} as const satisfies Record<string, CachePolicy>;

export const CACHE_POLICY = 'cache-policy';
export const CACHE_KEY = 'cache-key';

/**
 * Marks a public GET as cacheable and names the content it depends on.
 *
 * `key` is a FUNCTION of the request, so `/offices/municipal-engineering` and
 * `/offices/municipal-treasurer` invalidate independently — confirming a field
 * on one office must not expire the other, which is one of TAB 13's criteria.
 */
export const Cacheable = (
  policy: CachePolicy, key: (params: Record<string, string>) => string,
): MethodDecorator => (target, propertyKey, descriptor) => {
  SetMetadata(CACHE_POLICY, policy)(target, propertyKey, descriptor);
  SetMetadata(CACHE_KEY, key)(target, propertyKey, descriptor);
  return descriptor;
};

/**
 * The version of each cacheable resource.
 *
 * An ETag has to be computable WITHOUT producing the response, or a
 * revalidation costs exactly as much as a miss and 304 saves only bandwidth.
 * TAB 13 asks for a 304 with no database read, so the tag is derived from a
 * version counter held here rather than from a hash of the body.
 *
 * In memory, and deliberately so for a single-instance deployment. The process
 * nonce means a restart changes every tag: every client revalidates once and
 * gets a fresh answer. That is the SAFE direction to fail — a restart costs a
 * round of revalidation, never a stale fact about a municipality. Running more
 * than one instance would need this counter moved into the database; the shape
 * of the change is one method, and the honest note is that it has not been made
 * because the portal runs on one host.
 */
@Injectable()
export class ContentVersions {
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly versions = new Map<string, number>();

  versionOf(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /**
   * Called at the three moments content actually changes: confirmation,
   * publication, withdrawal. NOT on a proposal — a proposal changes nothing a
   * citizen can read, so expiring caches for one would be pure waste.
   */
  bump(...keys: string[]): void {
    for (const key of keys) this.versions.set(key, this.versionOf(key) + 1);
  }

  etagFor(key: string): string {
    const digest = createHash('sha256')
      .update(`${this.nonce}:${key}:${String(this.versionOf(key))}`)
      .digest('base64url')
      .slice(0, 27);
    // Strong, not weak: the bytes for a given key and version are identical.
    return `"${digest}"`;
  }
}
