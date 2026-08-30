import {
  DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';

import { ObjectStore } from '../domain/object-store';
import { SignedUrlVerdict, signObjectUrl, verifyObjectUrl } from '../domain/signed-url';

/**
 * Documents in S3-compatible object storage.
 *
 * Written for **Linode Object Storage** (owner's choice, 2026-08-30) and
 * deliberately not for AWS specifically: everything here is endpoint, bucket,
 * region and path-style addressing, so MinIO, Spaces or a Philippine provider
 * work without a code change. `@aws-sdk/client-s3` is the client because its
 * default credential chain means a storage key never has to enter this
 * service's own configuration -- an instance role or the standard AWS_*
 * variables supply it, and neither ends up in `.env.example`.
 *
 * ── Signed URLs are NOT bucket presigned URLs ───────────────────────────
 *
 * This store issues the same HMAC tokens the filesystem store does, redeemed by
 * this API. A bucket presigned URL would hand a browser a link straight to
 * Linode where this service can no longer say who may follow it, and would put
 * expiry and authorisation out of reach of the rules that own them. It would
 * also skip the checksum verification that happens when bytes pass through
 * here. See `domain/signed-url.ts`.
 *
 * ── What this class does not do ─────────────────────────────────────────
 *
 * No retry policy of its own, no multipart upload. The SDK retries idempotent
 * requests, and permit attachments are bounded by BODY_LIMIT_BYTES well under
 * the 5 GB single-PUT limit. Adding either without a measured need would be
 * code nobody has watched fail.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly signingKey: string,
    /**
     * Used ONLY by `isPubliclyReadable`, to fetch without credentials. Absent
     * means that check cannot run, and it answers `true` rather than `false` --
     * see the reasoning there.
     */
    private readonly publicProbeBase: string | null = null,
    private readonly clock: () => Date = () => new Date(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      // Server-side encryption asked for explicitly rather than left to a
      // bucket default, because a bucket default is a setting someone can turn
      // off without any code changing.
      ServerSideEncryption: 'AES256',
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
      }));
      if (result.Body === undefined) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      // A missing object is not an error worth propagating -- the caller's next
      // move is the same either way. Anything else IS: a credential or network
      // failure answered as "no such document" would look to an applicant like
      // their upload had vanished.
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(signObjectUrl(this.signingKey, key, expiresInSeconds, this.clock()));
  }

  verifySignedUrl(
    key: string, expiresAt: number, nonce: string, signature: string,
  ): SignedUrlVerdict {
    return verifyObjectUrl(this.signingKey, key, expiresAt, nonce, signature, this.clock());
  }

  /**
   * Attempts an UNAUTHENTICATED read, and reports what happened.
   *
   * The port's own words: a public bucket of applicants' identity documents is
   * the worst single failure this system can have, and it is a configuration
   * mistake rather than a code one, so code cannot prevent it -- only detect
   * it. Detection therefore has to be a real request with no credentials, not
   * an inspection of the bucket policy, because a policy this service is
   * allowed to read is not what an anonymous stranger sees.
   *
   * Answers TRUE when it cannot tell. An unreachable probe leaves the question
   * open, and the safe reading of "I do not know whether applicants' documents
   * are world-readable" is not "they are fine".
   */
  async isPubliclyReadable(): Promise<boolean> {
    if (this.publicProbeBase === null) return true;

    try {
      const response = await this.fetchImpl(
        `${this.publicProbeBase.replace(/\/+$/, '')}/${encodeURIComponent(this.bucket)}?max-keys=1`,
        { method: 'GET', redirect: 'manual' },
      );
      // 403 and 401 are the healthy answers: the bucket refused a stranger.
      // 404 means the bucket is not there at all, which is a different problem
      // and not this method's to report.
      if (response.status === 403 || response.status === 401 || response.status === 404) {
        return false;
      }
      return response.status < 400;
    } catch {
      return true;
    }
  }
}

function isNotFound(error: unknown): boolean {
  // Checked by shape rather than by instanceof: the SDK throws several distinct
  // classes for this (NoSuchKey, NotFound) and S3-compatible providers do not
  // all return the same one.
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === 'NoSuchKey'
    || named.name === 'NotFound'
    || named.$metadata?.httpStatusCode === 404;
}

/**
 * Builds the client from configuration.
 *
 * `forcePathStyle` because a custom endpoint is a custom endpoint: Linode,
 * MinIO and most S3-compatible providers address buckets by path, and
 * virtual-host style silently resolves to a hostname that does not exist.
 */
export function s3ClientFor(options: {
  endpoint: string; region: string;
}): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
  });
}
