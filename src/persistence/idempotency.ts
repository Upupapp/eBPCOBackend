import { createHash } from 'node:crypto';

import { SqlClient } from './sql-client';

/**
 * Do-this-once, for any operation that changes state.
 *
 * The payments module grew this first, inline. It is here because a second
 * inline copy is how two operations come to disagree about what a replay means
 * -- and because the guarantee is a property of the system, not of payments.
 *
 * What it is NOT is a substitute for optimistic concurrency. `expectedVersion`
 * answers "has anyone else changed this since I looked"; an idempotency key
 * answers "did MY request already happen". Both are needed, and the failure
 * that shows why is specific: an officer clicks Receive, the server commits,
 * the response is lost. Without a key the retry carries the version the officer
 * still has on screen, the server finds it stale, and answers "someone else
 * changed this application while it was open" -- which is untrue, unhelpful,
 * and in a permit office is a question about who did what.
 */
export interface Replay<T> {
  readonly status: number;
  readonly body: T;
}

export type IdempotencyOutcome<T> =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'replay'; readonly previous: Replay<T> }
  /** Same key, different request. A client bug, and honouring it would answer for the wrong request. */
  | { readonly kind: 'mismatch' };

/** A stable fingerprint of the request, so a replayed key with a changed body is caught. */
export function requestDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body) ?? '', 'utf8').digest('hex');
}

export async function lookup<T>(
  db: SqlClient,
  options: { accountId: string; key: string; operation: string; digest: string },
): Promise<IdempotencyOutcome<T>> {
  const result = await db.query<{ response_status: number; response_body: T; request_digest: string }>(
    `select response_status, response_body, request_digest from idempotency_keys
      where account_id = $1 and key = $2 and operation = $3`,
    [options.accountId, options.key, options.operation],
  );
  const previous = result.rows[0];
  if (previous === undefined) return { kind: 'fresh' };
  if (previous.request_digest !== options.digest) return { kind: 'mismatch' };
  return { kind: 'replay', previous: { status: previous.response_status, body: previous.response_body } };
}

/**
 * Records the outcome. Must run inside the same transaction as the change it
 * describes: recorded outside one, a rolled-back operation leaves a key that
 * replays a result nothing produced.
 */
export async function remember(
  tx: SqlClient,
  options: {
    accountId: string; key: string; operation: string; digest: string;
    status: number; body: unknown;
  },
): Promise<void> {
  await tx.query(
    `insert into idempotency_keys (key, account_id, operation, request_digest, response_status, response_body)
     values ($1,$2,$3,$4,$5,$6)`,
    [options.key, options.accountId, options.operation, options.digest, options.status,
     JSON.stringify(options.body)],
  );
}
