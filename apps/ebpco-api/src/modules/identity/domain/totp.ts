import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written here rather than pulled in, and that is a considered choice for this
 * one algorithm: it is forty lines of HMAC and a truncation defined by a
 * standard that has not moved since 2011, and it authenticates the officers who
 * approve permits. A dependency for it would be a supply-chain surface on the
 * second factor itself.
 *
 * ── The window ──────────────────────────────────────────────────────────
 *
 * One step either side of now. A phone whose clock is thirty seconds out is
 * common and is not an attack; a window of five steps is two and a half minutes
 * in which a shoulder-surfed code still works. One step is the usual compromise
 * and the one every authenticator app is built against.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, so a slightly wrong clock is not a lockout. */
const DRIFT_STEPS = 1;

/** RFC 4648 base32, which is what an authenticator app expects in a URI. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20): string {
  // 160 bits, the size RFC 4226 specifies for HMAC-SHA1.
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    // A character outside the alphabet is a malformed secret, not a zero.
    // Silently treating it as one would produce a secret that never matches
    // and no explanation anywhere.
    if (index === -1) throw new Error(`"${character}" is not valid base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The counter for an instant: seconds since the epoch, divided into steps. */
export function stepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

export function codeFor(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // Big-endian 64-bit. `writeBigUInt64BE` rather than two 32-bit halves,
  // because the high half is zero until the year 5000 and a hand-rolled split
  // is a bug waiting for a leap second.
  counter.writeBigUInt64BE(BigInt(step));

  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.3. The low nibble of the last byte chooses
  // where to read, so the digits depend on the whole MAC rather than a fixed
  // slice of it.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24)
    | ((mac[offset + 1]! & 0xff) << 16)
    | ((mac[offset + 2]! & 0xff) << 8)
    | (mac[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Whether `presented` is a code for `secret` around `at`.
 *
 * Returns the STEP it matched, or null. The step matters to the caller: a code
 * is valid for thirty seconds and reusable within them unless somebody records
 * which one was spent, and an attacker who watches a code being typed has that
 * whole window to use it again.
 */
export function verify(options: {
  secret: string; presented: string; at: Date; notBeforeStep?: number;
}): number | null {
  const { secret, presented, at } = options;
  if (!/^\d{6}$/.test(presented)) return null;

  const current = stepAt(at);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const step = current + offset;
    if (options.notBeforeStep !== undefined && step <= options.notBeforeStep) continue;

    const expected = Buffer.from(codeFor(secret, step), 'utf8');
    const candidate = Buffer.from(presented, 'utf8');
    // Constant-time even though both are six known-length digits: the habit is
    // what survives someone later making one of them variable.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) return step;
  }
  return null;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice — as a label prefix and as a parameter — because
 * older apps read one and newer ones read the other, and an officer with a code
 * labelled only by their email address cannot tell which of three government
 * systems it belongs to.
 */
export function provisioningUri(options: {
  secret: string; account: string; issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const parameters = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
