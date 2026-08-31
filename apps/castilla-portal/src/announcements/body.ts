/**
 * Rendering an announcement body for a browser.
 *
 * The input is plain text — always, by schema constraint — and everything is
 * escaped BEFORE any structure is added. That ordering is the whole security
 * argument: escape first, then build, so nothing a person typed can become
 * markup, and nothing this function builds can be re-escaped into visible
 * angle brackets.
 *
 * TAB 07 allows either a constrained markup or plain text with links. This is
 * the second, because it is the one with no parser to get wrong.
 */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** http/https only: a `javascript:` URL is a script with a link's costume. */
const LINK = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g;

export function renderBody(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(/\n/g, '<br>');
      // Applied to ALREADY-ESCAPED text, so the href can only contain
      // characters that survived escaping — there is no way back to a quote.
      const linked = escaped.replace(LINK, (url) =>
        `<a href="${url}" rel="noopener noreferrer nofollow">${url}</a>`);
      return `<p>${linked}</p>`;
    })
    .join('\n');
}
