/**
 * Replaces values that change on every run with fixed ones, so a diff of the
 * recorded responses shows a SHAPE change and nothing else.
 *
 * Without this, every regeneration rewrote every id, timestamp and cursor, and
 * a meaningful change was one real line among eighty noisy ones — which is how
 * a reviewer learns to skim a file rather than read it.
 *
 * **The constraint that makes this safe: a value is only replaced if it is
 * already valid.** A malformed timestamp is left exactly as the server produced
 * it, so the validator still sees it and still fails. Normalising
 * indiscriminately would turn a server bug into a passing gate — which is the
 * precise failure mode the recorded-response arrangement exists to avoid, and
 * it would be self-inflicted.
 *
 * It lives here rather than in the emitting script because it decides what
 * evidence looks like, and a correctness-critical function in an untested
 * script is one nobody checks.
 */

export const STABLE_UUID = '00000000-0000-4000-8000-000000000000';
export const STABLE_INSTANT = '2026-01-01T00:00:00.000Z';
export const STABLE_CURSOR = 'MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafDAwMDAwMDAw';

const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_BODY}$`, 'i');

/**
 * RFC 3339, and deliberately strict about the offset. A timestamp without one
 * is a timestamp two systems in different places disagree about — so if the
 * server ever emits one, it must reach the validator unchanged.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function stabilise(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilise(item, key));

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([name, nested]) => [name, stabilise(nested, name)]),
    );
  }

  if (typeof value !== 'string') return value;

  if (UUID.test(value)) return STABLE_UUID;
  if (INSTANT.test(value)) return STABLE_INSTANT;

  // A cursor is opaque and encodes a timestamp and an id, so it moves whenever
  // either does. Replaced only where the key says what it is, because an opaque
  // string cannot be recognised by shape without risking something else.
  if (key === 'nextCursor' && value.length > 0) return STABLE_CURSOR;

  // Paths and `instance` carry ids INLINE rather than as a whole value, so this
  // pattern must be unanchored. Reusing the anchored one silently matched
  // nothing and left every request path churning.
  return value.replace(new RegExp(UUID_BODY, 'gi'), STABLE_UUID);
}
