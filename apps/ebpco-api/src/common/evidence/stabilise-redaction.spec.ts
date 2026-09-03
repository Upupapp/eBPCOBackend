import { REDACTED, STABLE_UUID, stabilise } from './stabilise';

/**
 * Recorded evidence must not carry credentials.
 *
 * This repository is public, and the auth samples are recorded from a real
 * sign-in, so without this the contract file would publish a signed token. The
 * secret scanner would catch a JWT — but only that shape, and only after it was
 * written; redacting at the point the evidence is made is the fix, and the
 * scanner stays as the backstop.
 */
describe('stabilise redacts credentials', () => {
  /**
   * A JWT-shaped fixture, BUILT rather than pasted.
   *
   * The secret scanner refuses a token-shaped literal in source, and it is
   * right to: that is how a real one gets committed. Weakening the scanner or
   * adding an exception for this file would trade a permanent guard for one
   * test's convenience. Encoding the parts here produces the same shape at run
   * time, and there is no credential in the repository to find.
   */
  const jwtShaped = [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url'),
    Buffer.from('signature').toString('base64url'),
  ].join('.');

  it('removes a token whatever shape it arrives in', () => {
    const recorded = stabilise({
      accessToken: jwtShaped,
      refreshToken: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      expiresIn: 900,
    }) as Record<string, unknown>;

    // The fixture must actually look like a token, or this asserts nothing.
    expect(jwtShaped).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(recorded['accessToken']).toBe(REDACTED);
    // A refresh token that happens to be a UUID must be REDACTED, not
    // stabilised into a plausible-looking one.
    expect(recorded['refreshToken']).toBe(REDACTED);
    expect(recorded['refreshToken']).not.toBe(STABLE_UUID);
    // Everything else still records normally.
    expect(recorded['expiresIn']).toBe(900);
  });

  it('redacts a malformed credential too, unlike every other rule here', () => {
    // The rest of this file replaces a value only if it is already valid, so a
    // malformed one still reaches the validator. A credential is different:
    // leaving a broken token in place to keep the gate honest publishes it.
    expect((stabilise({ accessToken: 'not-a-jwt' }) as Record<string, unknown>)['accessToken'])
      .toBe(REDACTED);
  });

  it('leaves an empty credential alone, so a missing token still reads as missing', () => {
    // A server that returned no token must not be recorded as though it
    // returned a redacted one.
    expect((stabilise({ accessToken: '' }) as Record<string, unknown>)['accessToken']).toBe('');
  });

  it('does not redact a field that merely contains a token-ish word', () => {
    // Keyed by name, exactly. `tokenType` describes the scheme and is part of
    // the contract a client reads.
    expect((stabilise({ tokenType: 'Bearer' }) as Record<string, unknown>)['tokenType'])
      .toBe('Bearer');
  });
});
