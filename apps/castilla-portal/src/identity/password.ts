import { ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * `promisify` drops scrypt's options overload, so the cost parameters would be
 * silently ignored — a hash that looks right and is cheap to attack.
 */
function scryptAsync(
  password: string, salt: Buffer, keyLength: number, options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error !== null) reject(error); else resolve(derived);
    });
  });
}

/** `scrypt$N$r$p$salt$digest`, matching apps/ebpco-api so one reviewer reads both. */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scryptAsync(password, salt, KEY_LENGTH,
    { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

/**
 * Constant-time comparison, and a constant amount of WORK.
 *
 * A malformed or absent record still runs a full scrypt against a throwaway
 * salt before returning false, so 'this account does not exist' and 'that
 * password is wrong' take the same time. Otherwise the response time is an
 * account-existence oracle, and TAB 11 requires the two be indistinguishable.
 */
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parts = record.split('$');
  const [scheme, n, r, p, salt, digest] = parts;

  if (scheme !== 'scrypt' || parts.length !== 6
      || salt === undefined || digest === undefined) {
    await scryptAsync(password, randomBytes(16), KEY_LENGTH,
      { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
    return false;
  }

  const expected = Buffer.from(digest, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
