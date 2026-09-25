/**
 * The real, current `businesses.category` vocabulary (migration 041).
 *
 * Found duplicated as an identical inline `z.enum([...])` literal in six
 * places across three files (`businesses.controller.ts` x2,
 * `staff-businesses.controller.ts` x3, `staff-applications.controller.ts`
 * x1) — all six still agreed today, but that was luck, not something
 * enforced: this list had already drifted once before (to an older
 * six-value list missing Construction/Transport/Agriculture, per the
 * comments migration 041 left behind at each of those six call sites),
 * and nothing would have caught it drifting a second time. One shared
 * source now; a category added or renamed needs one edit, not six.
 */
export const BUSINESS_CATEGORIES = [
  'Retail', 'Food Service', 'Services', 'Manufacturing',
  'Construction', 'Transport', 'Agriculture', 'Other',
] as const;
