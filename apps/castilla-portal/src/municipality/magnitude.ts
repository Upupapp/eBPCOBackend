/**
 * Rendering an authored magnitude into the string a citizen reads.
 *
 * The direction matters: this formats a number INTO a display value and never
 * parses one out of a display string. TAB 04 forbids the reverse, and the
 * reason is a defect this portal already had — the home page hardcoded 60,635,
 * 186.2 and 34 rather than reading the sourced data, so revising the census
 * figure would have changed the label and not the number.
 *
 * Grouping is en-US because the portal's published figures are written that
 * way ('60,635'); it is a property of the authored data, not a locale guess.
 */
export interface Magnitude {
  readonly count: number;
  readonly suffix: string | null;
  readonly decimals: number | null;
}

export function formatMagnitude({ count, suffix, decimals }: Magnitude): string {
  const places = decimals ?? 0;
  const rendered = count.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
  return suffix === null || suffix === '' ? rendered : `${rendered} ${suffix}`;
}
