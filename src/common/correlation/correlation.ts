import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * One id that follows a request from the client through every log line and
 * into the database.
 *
 * Held in AsyncLocalStorage rather than passed down through call signatures,
 * so a service three layers deep can name the request it is serving without
 * every function in between growing a parameter it does not otherwise need.
 * The id also travels back to the caller on every response and inside every
 * Problem Details body, which is what makes an applicant's bug report
 * actionable instead of anecdotal.
 */

export const CORRELATION_HEADER = 'x-correlation-id';

interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Accept a caller-supplied id only if it is plausibly one of ours.
 *
 * An unbounded header value would end up in every log line for that request,
 * which is a log-injection and log-volume surface handed to anyone who can
 * make a request.
 */
export function sanitiseCorrelationId(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
