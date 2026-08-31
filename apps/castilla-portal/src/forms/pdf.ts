import { inflateSync } from 'node:zlib';

/**
 * Just enough PDF to read a page count and the revision a form prints on itself.
 *
 * Deliberately not a PDF library and deliberately READ-ONLY: TAB 06 forbids
 * re-generating, flattening or re-exporting these documents, so nothing here
 * ever writes a PDF. It answers two questions about bytes it does not modify.
/**
 * Text-showing arrays: `[(B) -2 (F) -3 (P)] TJ`. Lazy `.*?` because on a
 * megabyte-scale content stream an alternation of character classes overflows V8's regex
 * stack outright, which reads as a corrupt PDF rather than as a bad pattern.
 */
const TJ_ARRAY = /\[(.*?)\]\s*TJ/gs;
/** A PDF literal string, honouring backslash escapes. */
const LITERAL = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/gs;

/**
 * The text a PDF draws, approximately.
 *
 * The subtlety that matters: within ONE TJ array each glyph is usually its own
 * literal, separated by kerning numbers, so `REV` is three literals and never
 * appears as contiguous bytes. Literals therefore concatenate WITHIN an array
 * and only arrays are separated — joining every literal with a space instead
 * yields 'R E V' and silently matches nothing.
 */
export function pdfText(pdf: Buffer): string {
  const content = inflatedStreams(pdf);
  const chunks: string[] = [];

  for (const array of content.matchAll(TJ_ARRAY)) {
    let chunk = '';
    for (const literal of array[1]!.matchAll(LITERAL)) chunk += literal[1]!;
    if (chunk !== '') chunks.push(chunk);
  }

  return chunks.join(' ')
    .replace(/\\([()])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function inflatedStreams(pdf: Buffer): string {
  const parts: string[] = [];
  const text = pdf.toString('latin1');

  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      // A stream's captured range includes the newline before `endstream`, and
      // a strict inflate rejects those trailing bytes — silently skipping every
      // content stream and reporting a document with no text at all.
      parts.push(inflateSync(Buffer.from(text.slice(start, end), 'latin1'),
        { finishFlush: 2 /* Z_SYNC_FLUSH */ }).toString('latin1'));
    } catch {
      // An image stream, or a filter this reader does not implement. Skipped:
      // it holds no text, and failing the import over it would refuse a form
      // for containing a photograph.
    }
  }
  return parts.join('\n');
}

/** The page count from the catalogue's /Count, which every one of these carries. */
export function pageCount(pdf: Buffer): number | null {
  const counts = [...pdf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)]
    .map((m) => Number(m[1]));
  const pages = counts.filter((n) => n > 0);
  return pages.length === 0 ? null : Math.max(...pages);
}

/**
 * Revision identifiers as the LGU and the BFP actually print them.
 *
 * Matched with `\s*` between the parts because the glyph-by-glyph text above
 * reconstructs 'BFP-QSF-FSED-001' as 'BFP - QSF - FSED - 001'; the spacing is
 * an artefact of kerning, not of the document.
 */
const REVISION_PATTERNS: readonly RegExp[] = [
  /BFP\s*-\s*QSF\s*-\s*[A-Z]+\s*-\s*\d+\s*REV\.?\s*\d+\s*\([\d.]+\)/i,
  /FM\s*-\s*MPD\s*-\s*\d+(?:\s*,\s*Updated as of\s+[A-Z][a-z]+\s+\d{4})?/i,
];

export function revisionLabel(pdf: Buffer): string | null {
  const text = pdfText(pdf);

  for (const pattern of REVISION_PATTERNS) {
    const found = pattern.exec(text);
    if (found === null) continue;
    let label = found[0].replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
    // The zoning form prints its update date beside its code but not inside it.
    if (/^FM-MPD/i.test(label) && !/Updated as of/i.test(label)) {
      const updated = /Updated as of\s+[A-Z][a-z]+\s+\d{4}/i.exec(text);
      if (updated !== null) label = `${label}, ${updated[0].replace(/\s+/g, ' ')}`;
    }
    return label;
  }
  // 10 of the 13 print no revision at all. That is a fact about the documents.
  return null;
}
