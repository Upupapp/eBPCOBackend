/**
 * The state a reader sees, derived rather than stored.
 *
 * Only three statuses are ever set by a person — draft, published, withdrawn.
 * 'scheduled' and 'expired' are what the clock makes of a published
 * announcement, so no job has to run for a notice to go live or lapse, and no
 * job stopping can leave last year's typhoon advisory on a government homepage.
 */
export type AnnouncementState =
  | 'draft' | 'scheduled' | 'published' | 'expired' | 'withdrawn';

export interface AnnouncementTiming {
  readonly status: 'draft' | 'published' | 'withdrawn';
  readonly publishedAt: Date | null;
  readonly expiresAt: Date | null;
}

export function stateOf(timing: AnnouncementTiming, now: Date): AnnouncementState {
  if (timing.status === 'withdrawn') return 'withdrawn';
  if (timing.status === 'draft' || timing.publishedAt === null) return 'draft';
  if (timing.publishedAt.getTime() > now.getTime()) return 'scheduled';
  if (timing.expiresAt !== null && timing.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'published';
}

/** What a citizen may read by slug: live now, or lived once. */
export function isReadable(state: AnnouncementState): boolean {
  return state === 'published' || state === 'expired';
}

/** What belongs in the list and the header count. */
export function isCurrent(state: AnnouncementState): boolean {
  return state === 'published';
}
