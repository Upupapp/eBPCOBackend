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

/**
 * What a credential is replaced with.
 *
 * Redaction, not stabilisation, and the difference matters. Everything else in
 * this file is replaced only if it is ALREADY VALID, so a malformed value still
 * reaches the validator and still fails. A credential is replaced whatever it
 * looks like, because the reason is secrecy rather than noise: a malformed
 * token left in place to "keep the gate honest" is a token published in a
 * public repository, and this one is public.
 *
 * It is not a plausible token either. A placeholder shaped like a real JWT
 * would be copied into a client as a fixture and then wondered about.
 */
export const REDACTED = '<redacted>';

/**
 * Keys whose VALUE is a credential, whatever shape it arrives in.
 *
 * By name rather than by pattern. A bearer token is an opaque string, so there
 * is nothing about the value itself that reliably says "this is a secret" --
 * and a pattern that tried would either miss an unusual one or redact an
 * innocent field that happened to match.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'accessToken', 'refreshToken', 'token', 'password', 'otpauthUri', 'secret',
]);

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

  // Before every other rule, and before the "only if already valid" constraint:
  // a credential is redacted whatever it looks like. A refresh token that
  // happens to be a UUID would otherwise be stabilised into a plausible-looking
  // one rather than removed.
  if (CREDENTIAL_KEYS.has(key) && value.length > 0) return REDACTED;

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
