import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts a secret this service must be able to read back.
 *
 * A TOTP secret cannot be hashed: verifying a code means recomputing an HMAC
 * over it, so the plaintext has to be recoverable. That makes it unlike a
 * password verifier and means the protection has to come from a key held
 * OUTSIDE the database — a database-only leak then yields ciphertext rather
 * than every officer's second factor.
 *
 * AES-256-GCM, so a tampered record fails to decrypt rather than decrypting to
 * something else. A stored secret that could be altered undetected would let
 * anyone who can write to the table replace an officer's factor with one they
 * hold.
 */

const VERSION = 'v1';

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    // The configured value is a passphrase of unknown length; AES needs exactly
    // 32 bytes. SHA-256 rather than a KDF because this material is already
    // required to be 32+ characters of secret from a secret manager, not a
    // human-chosen password — there is no low-entropy guess to slow down.
    this.key = createHash('sha256').update(keyMaterial, 'utf8').digest();
  }

  seal(plaintext: string): string {
    // A fresh nonce every time. Reusing one under the same key with GCM is
    // catastrophic rather than merely weak: it leaks the XOR of two plaintexts
    // and the authentication key itself.
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    // Versioned, so a future change of algorithm can be told apart from a
    // corrupt record rather than guessed at.
    return [VERSION, nonce.toString('base64'), sealed.toString('base64'),
      cipher.getAuthTag().toString('base64')].join('.');
  }

  open(sealed: string): string | null {
    const [version, nonce, body, tag] = sealed.split('.');
    if (version !== VERSION || nonce === undefined || body === undefined || tag === undefined) {
      return null;
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64')), decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, or a tampered record. Null rather than a throw: the caller's
      // answer is the same either way — this account has no usable factor — and
      // distinguishing them here would mean deciding which is worse at a point
      // that cannot tell.
      return null;
    }
  }
}
