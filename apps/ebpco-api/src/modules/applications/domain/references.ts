import { randomUUID } from 'node:crypto';

/**
 * An application's reference number (QA finding TC-37, 2026-10-03).
 *
 * The official E-BPCO-YYYY-NNNNNN number is issued when an application is
 * FILED, not when a draft is first saved: an abandoned draft used to keep the
 * number it took, leaving gaps in the official series. A draft carries a
 * temporary DRAFT-… label instead, unique like any reference, and takes the
 * next official number when it moves to Submitted (migration 064's
 * `next_application_reference`, the one place numbers come from).
 */
export const DRAFT_REFERENCE_PREFIX = 'DRAFT-';

/** A draft's temporary label: DRAFT- and ten hex characters. */
export function draftReference(): string {
  return `${DRAFT_REFERENCE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

export function isDraftReference(reference: string | null | undefined): boolean {
  return typeof reference === 'string' && reference.startsWith(DRAFT_REFERENCE_PREFIX);
}
