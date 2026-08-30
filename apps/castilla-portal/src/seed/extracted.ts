/** The shape `scripts/extract-portal-data.ts` writes. */
export interface ExtractedEntity {
  readonly source: string;
  readonly ordinal: number;
  readonly fields: Record<string, unknown>;
  readonly comment: string | null;
  /**
   * The comment on the declaration this entity belongs to. Provenance that
   * covers a group, such as the note naming the 2025 election results as the
   * source for the Mayor and Vice Mayor.
   */
  readonly scopeComment?: string;
  /** The comment at the head of the file the entity came from. */
  readonly fileComment?: string;
  readonly fieldComments: Record<string, string>;
}

export interface ExtractedPortalData {
  readonly repo: string;
  readonly commit: string;
  readonly files: Record<string, ExtractedEntity[]>;
}

/** A helper call or identifier the extractor recorded rather than resolved. */
export function expressionOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const expr = (value as { __expression?: unknown }).__expression;
  return typeof expr === 'string' ? expr : null;
}

/**
 * The expressions a `{ ...helper(), field: 'x' }` spread carries.
 *
 * A spread was invisible to the seeder until 2026-08-30: the extractor kept
 * only the literal properties, so an office whose contact spread
 * `placeholderContact()` lost `isPlaceholder: true` and read as a sourced
 * fact. Returned as expressions, not values, because what a helper MEANS is a
 * seeding decision — see `expressionOf`.
 */
export function spreadsOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const spreads = (value as { __spread?: unknown }).__spread;
  if (!Array.isArray(spreads)) return [];
  return spreads.map(expressionOf).filter((e): e is string => e !== null);
}
