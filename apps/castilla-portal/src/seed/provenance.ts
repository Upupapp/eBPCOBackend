import { ExtractedEntity } from './extracted';

/**
 * Turning a sourcing comment into a provenance record.
 *
 * TAB 15's guardrail is that a seeded value stays pending "unless the committed
 * comment cites a source, and the seeder must read that comment rather than
 * assume". So this reads. What it will not do is invent: a comment that does
 * not carry a date, or whose method cannot be told from its words, produces a
 * REPORTED GAP rather than a plausible record.
 *
 * That matters because of the schema: `confirmed` requires provenance, enforced
 * by the database. A guessed method would not fail loudly -- it would sit in
 * the audit trail looking like a fact somebody checked.
 */

export type Method = 'direct-read' | 'search-extraction' | 'official-document';

export interface Provenance {
  readonly sourceDescription: string;
  readonly sourcedOn: string;
  readonly method: Method;
}

export type Reading =
  | { readonly ok: true; readonly provenance: Provenance }
  | { readonly ok: false; readonly reason: string };

/**
 * Phrases that state HOW a fact was obtained, in the source's own words.
 *
 * Ordered: a comment saying it read an official document THROUGH search
 * extraction is a search extraction, because that is the weaker claim and the
 * one a reader needs. Several facts here were obtained that way precisely
 * because `castillasorsogon.gov.ph` blocks automated fetching, and TAB 15 says
 * that limitation is part of the record.
 */
const METHOD_PHRASES: ReadonlyArray<readonly [RegExp, Method]> = [
  // 'via web search' is the source's own wording in two office-head notes and
  // means exactly this. Added because the classifier reported them as
  // unreadable rather than guessing -- which is the behaviour working, and the
  // fix is to widen it on the evidence rather than to loosen the default.
  [/search[- ]result extraction|via (web )?search|blocks automated fetching|search results/i,
    'search-extraction'],
  // 'LGU-published ... material' is the source's own phrasing for a document
  // the LGU issued. Added on the evidence, after the classifier reported it as
  // unreadable rather than guessing.
  [/citizen'?s charter|LGU-(published|issued)|official .{0,20}(document|publication|material)|PSA |presentation|gazette/i,
    'official-document'],
  [/\bpost\b|\bpage\b|institutional material|publication|infobox|election results/i,
    'direct-read'],
];

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

export function readProvenance(comment: string | null): Reading {
  if (comment === null || comment.trim().length === 0) {
    return { ok: false, reason: 'no comment to read' };
  }

  const date = ISO_DATE.exec(comment);
  if (date === null) {
    // Not a failure of the comment -- several are notes about why a fact is
    // ABSENT, which is a different thing and correctly has no sourcing date.
    return { ok: false, reason: 'the comment carries no sourced-on date' };
  }

  const method = METHOD_PHRASES.find(([pattern]) => pattern.test(comment))?.[1];
  if (method === undefined) {
    return {
      ok: false,
      reason: 'the comment carries a date but no phrase saying how the fact was obtained; '
        + 'guessing the method would put an unchecked claim in the audit trail',
    };
  }

  // The comment IS the description, whole. Summarising it here would be this
  // seeder deciding which half of someone's careful sourcing note matters.
  return { ok: true, provenance: { sourceDescription: comment, sourcedOn: date[1]!, method } };
}

/**
 * The comments that could apply to a field, MOST SPECIFIC FIRST.
 *
 * A list rather than a single winner, because "the nearest comment" and "the
 * nearest comment that actually sources this fact" are different questions and
 * only the second one is useful. The note above `export const SB_MEMBERS`
 * explains how two members' ballot names were recorded; it is a real note and
 * it is not a source, and while it shadowed the file header the eight
 * Sangguniang Bayan members were all reported unsourced — with the file
 * explicitly sourcing them four lines further up.
 */
export function commentsFor(entity: ExtractedEntity, field: string): string[] {
  return [
    entity.fieldComments[field], entity.comment, entity.scopeComment, entity.fileComment,
  ].filter((comment): comment is string => typeof comment === 'string' && comment.trim() !== '');
}

/**
 * The first comment in scope that reads as a provenance record.
 *
 * Widening to an enclosing scope is legitimate ONLY for a comment that carries
 * a date and a method: that is a statement about where these facts came from,
 * which by its nature covers the declaration it heads. It never invents a
 * source for a fact nobody sourced — if no comment in scope reads, the reason
 * reported is the MOST SPECIFIC one's, because that is the comment whose author
 * was closest to the fact and the one someone would go and fix.
 */
export function provenanceFor(entity: ExtractedEntity, field: string): Reading {
  const candidates = commentsFor(entity, field);
  if (candidates.length === 0) return { ok: false, reason: 'no comment to read' };

  for (const comment of candidates) {
    const reading = readProvenance(comment);
    if (reading.ok) return reading;
  }
  return readProvenance(candidates[0]!);
}

/** @deprecated Use {@link provenanceFor}: this stops at the first comment that EXISTS. */
export function commentFor(entity: ExtractedEntity, field: string): string | null {
  return commentsFor(entity, field)[0] ?? null;
}
