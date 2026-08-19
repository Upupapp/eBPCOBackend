import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` resolves to the three-argument overload, which cannot carry the
 * cost parameters. Typed explicitly so the options form is reachable.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password verifier storage.
 *
 * scrypt, from Node's own crypto module. OWASP's password-storage guidance
 * ranks Argon2id first and scrypt second, and scrypt is explicitly acceptable
 * where Argon2id is unavailable. Argon2id in Node needs a native binding, and
 * for a service that will hold applicant personal data the supply-chain cost of
 * a compiled third-party dependency in the credential path is a worse trade
 * than the gap between first and second place. Both are memory-hard, which is
 * the property that matters against GPU attack.
 *
 * The encoded form carries its own parameters, so raising the cost later does
 * not invalidate existing verifiers -- an account rehashes on next successful
 * sign-in rather than locking its owner out.
 *
 * Nothing here is reversible. There is no "get the password" operation because
 * there is no circumstance in which this service should have one.
 */

export interface ScryptCost {
  /** CPU/memory cost. Must be a power of two. Memory used is roughly 128 * N * r bytes. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

/**
 * ~64 MiB per hash (128 * 65536 * 8). Deliberately expensive.
 *
 * Memory cost multiplies by concurrency, so this is a denial-of-service
 * surface as well as a defence: TAB 16 profiles it under load and this is the
 * number that gets tuned. It is a parameter and not a constant for that reason.
 */
export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 65_536, r: 8, p: 2, keyLength: 64 };

/**
 * Cheap parameters for tests only.
 *
 * The same discipline the mobile app applies to its PBKDF2 verifier: a test
 * suite that spends 64 MiB and 100ms per hash stops being run.
 */
export const TEST_SCRYPT_COST: ScryptCost = { N: 1_024, r: 8, p: 1, keyLength: 32 };

const SALT_BYTES = 16;

export class PasswordHasher {
  constructor(
    private readonly cost: ScryptCost = DEFAULT_SCRYPT_COST,
    /**
     * A server-side secret mixed into every hash, held in the secret manager
     * and never in the database.
     *
     * If the database alone is exfiltrated -- the common case, via backup or
     * injection -- the verifiers are not crackable without it. Empty is
     * permitted so development does not need a secret manager, and TAB 14
     * checks it is set outside development.
     */
    private readonly pepper: string = '',
  ) {
    if (!Number.isInteger(Math.log2(cost.N))) {
      throw new Error('scrypt N must be a power of two');
    }
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await this.derive(password, salt);
    return [
      'scrypt',
      this.cost.N,
      this.cost.r,
      this.cost.p,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  /**
   * Constant-time verification.
   *
   * A malformed or unparseable verifier returns false rather than throwing: a
   * corrupt row must fail the sign-in, not take the endpoint down.
   */
  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = this.parse(encoded);
    if (parsed === null) return false;

    const derived = await this.derive(password, parsed.salt, parsed.cost);
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  }

  /**
   * Whether a stored verifier was made with weaker parameters than current
   * policy, so it can be upgraded on the next successful sign-in.
   */
  needsRehash(encoded: string): boolean {
    const parsed = this.parse(encoded);
    if (parsed === null) return true;
    return (
      parsed.cost.N < this.cost.N ||
      parsed.cost.r < this.cost.r ||
      parsed.cost.p < this.cost.p
    );
  }

  private async derive(password: string, salt: Buffer, cost: ScryptCost = this.cost): Promise<Buffer> {
    // Node's scrypt refuses to allocate beyond maxmem, which defaults below
    // what N=65536,r=8 needs.
    const maxmem = 256 * cost.N * cost.r;
    return scryptAsync(`${password}${this.pepper}`, salt, cost.keyLength, {
      N: cost.N,
      r: cost.r,
      p: cost.p,
      maxmem,
    });
  }

  private parse(encoded: string): { cost: ScryptCost; salt: Buffer; hash: Buffer } | null {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

    const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
    if (rawSalt === undefined || rawHash === undefined) return null;

    try {
      const hash = Buffer.from(rawHash, 'base64url');
      return {
        cost: { N, r, p, keyLength: hash.length },
        salt: Buffer.from(rawSalt, 'base64url'),
        hash,
      };
    } catch {
      return null;
    }
  }
}
