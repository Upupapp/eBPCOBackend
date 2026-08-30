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
  /**
   * Where the request came from. Held here for the same reason the id is: an
   * audit entry written three layers down must be able to say where an act came
   * from, and threading an address through every service signature would put a
   * networking detail into domain code that has no other use for one.
   *
   * `undefined` rather than a placeholder when it cannot be determined. A
   * fabricated address in an accountability record is worse than an absent one.
   */
  readonly sourceAddress?: string | undefined;
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

export function runWithCorrelationId<T>(
  correlationId: string, fn: () => T, sourceAddress?: string,
): T {
  return storage.run({ correlationId, sourceAddress }, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function currentSourceAddress(): string | undefined {
  return storage.getStore()?.sourceAddress;
}

/**
 * The caller's address, as PostgreSQL's `inet` will accept it.
 *
 * Fastify reports an IPv4 caller over an IPv6 socket as `::ffff:127.0.0.1`,
 * which `inet` rejects outright -- and a rejected insert inside an audit append
 * fails the transaction carrying the act being audited. Normalised here rather
 * than at each call site, and anything still unrecognisable becomes `null`:
 * a missing address costs an investigator one field, while a failed write costs
 * the whole record.
 */
export function normaliseSourceAddress(candidate: string | undefined): string | null {
  if (candidate === undefined || candidate.trim().length === 0) return null;
  const address = candidate.trim().replace(/^::ffff:/i, '');
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(address)) return address;
  if (/^[0-9a-f:]{2,45}$/i.test(address) && address.includes(':')) return address;
  return null;
}
