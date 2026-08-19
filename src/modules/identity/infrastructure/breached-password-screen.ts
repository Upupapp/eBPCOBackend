import { createHash } from 'node:crypto';

import { BreachedPasswordScreen } from '../domain/password-policy';

/**
 * The most common breached passwords, held locally.
 *
 * A local list rather than a call to Have I Been Pwned's range API, for two
 * reasons. A government service should not make an outbound request to a third
 * party on every registration -- even k-anonymised, that is a dependency in the
 * credential path and a signal leaving the country. And a service that cannot
 * reach the internet must still be able to reject "password123", so the check
 * must not fail open on a network error.
 *
 * The trade is recall: this catches the passwords that actually appear in
 * credential-stuffing lists rather than all 800 million known ones. TAB 14 can
 * replace it with a bundled full corpus; the interface does not change.
 *
 * Stored as SHA-1 prefixes of the lowercase password so the file is not itself
 * a usable password list, and matched case-insensitively because attackers try
 * capitalisation variants first.
 */
const COMMON_PASSWORDS = [
  'password', 'password1', 'password123', 'password1234', 'passw0rd',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'letmein', 'welcome', 'welcome123', 'admin', 'admin123', 'administrator',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'basketball',
  'monkey', 'dragon', 'master', 'shadow', 'superman', 'trustno1',
  'abc123', 'abcd1234', 'a1b2c3d4', 'changeme', 'default', 'secret',
  'philippines', 'pilipinas', 'manila123', 'quezoncity', 'mahalkita',
  'ebpco123', 'buildingpermit', 'permit123',
];

export class LocalBreachedPasswordScreen implements BreachedPasswordScreen {
  private readonly digests: ReadonlySet<string>;

  constructor(extra: readonly string[] = []) {
    this.digests = new Set(
      [...COMMON_PASSWORDS, ...extra].map((password) => LocalBreachedPasswordScreen.digest(password)),
    );
  }

  isBreached(password: string): Promise<boolean> {
    // Padding a known-bad password to reach a length floor does not make it
    // unknown. "letmein12345" is not a twelve-character password an attacker
    // has never seen -- it is "letmein" with the first thing anyone appends.
    // Each candidate below is one such transformation, undone.
    const lower = password.toLowerCase();
    const alphanumeric = lower.replace(/[^a-z0-9]/g, '');

    const candidates = new Set([
      lower,
      alphanumeric,
      // trailing digits, the single most common padding
      alphanumeric.replace(/\d+$/, ''),
      // a trailing run of one repeated character: "password!!!!" -> "password"
      lower.replace(/(.)\1+$/, ''),
      // letters only, which catches "p4ssw0rd"-style substitution poorly but
      // "password2026!" well
      lower.replace(/[^a-z]/g, ''),
    ]);

    for (const candidate of candidates) {
      // Below four characters every candidate collides with something; a
      // password is not breached merely because stripping it left "a".
      if (candidate.length < 4) continue;
      if (this.digests.has(LocalBreachedPasswordScreen.digest(candidate))) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  private static digest(password: string): string {
    return createHash('sha1').update(password, 'utf8').digest('hex');
  }
}
