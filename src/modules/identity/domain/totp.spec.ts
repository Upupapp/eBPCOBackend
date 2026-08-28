import { base32Decode, base32Encode, codeFor, provisioningUri, stepAt, verify } from './totp';

/**
 * RFC 6238's own test vectors.
 *
 * An implementation checked only against itself proves that it is consistent,
 * not that it is right — and an authenticator app on an officer's phone was
 * built against the standard, not against this file. These are the published
 * values for the SHA-1 variant, with the RFC's ASCII secret "12345678901234567890"
 * expressed in base32 as the algorithm actually takes it.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 6238 test vectors', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('at unix time %i the code is %s', (seconds, expected) => {
    const at = new Date(seconds * 1000);
    expect(codeFor(RFC_SECRET, stepAt(at))).toBe(expected);
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const source of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const bytes = Buffer.from(source, 'ascii');
      expect(base32Decode(base32Encode(bytes)).toString('ascii')).toBe(source);
    }
  });

  it('refuses a character outside the alphabet instead of reading it as zero', () => {
    // A malformed secret that decoded silently would produce a code that never
    // matches, with no explanation anywhere.
    expect(() => base32Decode('ABC!DEF')).toThrow(/not valid base32/);
  });
});

describe('verifying a code', () => {
  const secret = RFC_SECRET;
  const now = new Date(1_234_567_890 * 1000);

  it('accepts the code for this moment', () => {
    expect(verify({ secret, presented: codeFor(secret, stepAt(now)), at: now })).not.toBeNull();
  });

  it('accepts ONE step either side, because a phone clock is often slightly out', () => {
    for (const offset of [-1, 1]) {
      const code = codeFor(secret, stepAt(now) + offset);
      expect(verify({ secret, presented: code, at: now })).not.toBeNull();
    }
  });

  it('refuses two steps away, because that is a minute of shoulder-surfing', () => {
    for (const offset of [-2, 2]) {
      const code = codeFor(secret, stepAt(now) + offset);
      expect(verify({ secret, presented: code, at: now })).toBeNull();
    }
  });

  it('REFUSES A CODE ALREADY SPENT', () => {
    // A code is valid for thirty seconds and reusable within them unless
    // somebody records which step was used. An attacker who watched it being
    // typed has that whole window.
    const step = stepAt(now);
    const code = codeFor(secret, step);

    expect(verify({ secret, presented: code, at: now })).toBe(step);
    expect(verify({ secret, presented: code, at: now, notBeforeStep: step })).toBeNull();
  });

  it('refuses anything that is not six digits before it reaches an HMAC', () => {
    for (const presented of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(verify({ secret, presented, at: now })).toBeNull();
    }
  });
});

describe('the provisioning URI', () => {
  it('names the issuer twice, because apps differ on which one they read', () => {
    const uri = provisioningUri({
      secret: RFC_SECRET, account: 'officer@lgu.gov.ph', issuer: 'eBPCO Castilla',
    });

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent('eBPCO Castilla:officer@lgu.gov.ph'));
    expect(uri).toContain('issuer=eBPCO+Castilla');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});
