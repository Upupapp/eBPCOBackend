import { createHash } from 'node:crypto';

/**
 * Tamper-evidence for the audit trail.
 *
 * Each entry commits to the one before it. Removing or editing a row breaks
 * every row after it, so a single pass detects it.
 *
 * This is deliberately not claimed to be more than it is. Someone with database
 * superuser rights can recompute the whole chain, and no in-database scheme can
 * stop that; write-once storage or an external anchor is what would. What this
 * does is raise tampering from one UPDATE, which nobody would notice, to
 * rewriting every row since, which is a different kind of act and leaves
 * different evidence.
 */

export interface ChainableEvent {
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly actorAccountId: string | null;
  readonly actorRole: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly correlationId: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
}

export const GENESIS = 'genesis';

/**
 * The canonical form an entry is hashed over.
 *
 * Field order is fixed and explicit rather than taken from object key order,
 * because two runtimes serialising the same object can differ, and a chain that
 * verifies on one machine and not another is worse than no chain. The state
 * blobs are key-sorted for the same reason.
 */
function canonical(event: ChainableEvent): string {
  return [
    event.sequence,
    event.occurredAt.toISOString(),
    event.actorAccountId ?? '',
    event.actorRole ?? '',
    event.action,
    event.subjectType,
    event.subjectId ?? '',
    event.outcome,
    event.correlationId ?? '',
    stableJson(event.beforeState),
    stableJson(event.afterState),
  ].join(' ');
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}

export function hashEntry(previousHash: string, event: ChainableEvent): string {
  return createHash('sha256').update(`${previousHash} ${canonical(event)}`, 'utf8').digest('hex');
}

export type ChainVerdict =
  | { readonly intact: true; readonly length: number }
  | {
      readonly intact: false;
      /** The first entry whose hash does not follow from its predecessor. */
      readonly brokenAtSequence: number;
      readonly reason: 'hash-mismatch' | 'sequence-gap' | 'out-of-order';
    };

/**
 * Walks the chain from genesis.
 *
 * Reports the FIRST break rather than every mismatch: once a chain is broken,
 * every subsequent hash is computed over a different history, and reporting
 * them all buries the one that matters.
 */
export function verifyChain(
  entries: ReadonlyArray<ChainableEvent & { entryHash: string; previousHash: string | null }>,
): ChainVerdict {
  let expectedPrevious = GENESIS;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      return {
        intact: false,
        brokenAtSequence: entry.sequence,
        reason: entry.sequence < expectedSequence ? 'out-of-order' : 'sequence-gap',
      };
    }
    if ((entry.previousHash ?? GENESIS) !== expectedPrevious) {
      return { intact: false, brokenAtSequence: entry.sequence, reason: 'hash-mismatch' };
    }
    if (hashEntry(expectedPrevious, entry) !== entry.entryHash) {
      return { intact: false, brokenAtSequence: entry.sequence, reason: 'hash-mismatch' };
    }

    expectedPrevious = entry.entryHash;
    expectedSequence += 1;
  }

  return { intact: true, length: entries.length };
}
