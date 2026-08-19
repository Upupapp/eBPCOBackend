import { PasswordHasher, TEST_SCRYPT_COST } from './password-hasher';

const hasher = new PasswordHasher(TEST_SCRYPT_COST);

describe('password hashing', () => {
  it('verifies the password it hashed', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('correct horse battery staple', encoded)).resolves.toBe(true);
  });

  it('rejects a different password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('correct horse battery stapler', encoded)).resolves.toBe(false);
  });

  it('never stores the password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    expect(encoded).not.toContain('correct');
    expect(encoded).not.toContain('staple');
  });

  it('produces a different verifier each time, so equal passwords are not equal rows', async () => {
    // Without a per-credential salt, a database dump reveals which accounts
    // share a password -- and cracking one cracks all of them.
    const first = await hasher.hash('the same password');
    const second = await hasher.hash('the same password');

    expect(first).not.toBe(second);
    await expect(hasher.verify('the same password', first)).resolves.toBe(true);
    await expect(hasher.verify('the same password', second)).resolves.toBe(true);
  });

  it('records its own parameters, so the cost can be raised later', async () => {
    const encoded = await hasher.hash('a password');

    expect(encoded.startsWith(`scrypt$${TEST_SCRYPT_COST.N}$${TEST_SCRYPT_COST.r}$${TEST_SCRYPT_COST.p}$`)).toBe(true);
  });

  it('still verifies a credential hashed under weaker parameters', async () => {
    // Raising the cost must not lock existing accounts out.
    const weak = new PasswordHasher({ N: 256, r: 8, p: 1, keyLength: 32 });
    const encoded = await weak.hash('an older password');

    await expect(hasher.verify('an older password', encoded)).resolves.toBe(true);
  });

  it('flags a weaker verifier for rehash on next sign-in', async () => {
    const weak = new PasswordHasher({ N: 256, r: 8, p: 1, keyLength: 32 });

    expect(hasher.needsRehash(await weak.hash('x'))).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('x'))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not scrypt', 'bcrypt$10$abc$def'],
    ['too few fields', 'scrypt$1024$8$salt'],
    ['non-numeric cost', 'scrypt$N$8$1$c2FsdA$aGFzaA'],
    ['plain text, as if a migration went wrong', 'hunter2'],
  ])('returns false rather than throwing on a corrupt verifier: %s', async (_label, encoded) => {
    // A corrupt row must fail the sign-in, not take the endpoint down.
    await expect(hasher.verify('anything', encoded)).resolves.toBe(false);
  });

  it('treats a corrupt verifier as needing rehash', () => {
    expect(hasher.needsRehash('nonsense')).toBe(true);
  });

  it('refuses a cost that scrypt cannot use', () => {
    expect(() => new PasswordHasher({ N: 1000, r: 8, p: 1, keyLength: 32 })).toThrow(/power of two/);
  });

  it('binds the verifier to the pepper', async () => {
    // If the database alone leaks -- the common case -- the verifiers are not
    // crackable without the secret held elsewhere.
    const withPepper = new PasswordHasher(TEST_SCRYPT_COST, 'server-side-secret');
    const withoutPepper = new PasswordHasher(TEST_SCRYPT_COST);

    const encoded = await withPepper.hash('a password');

    await expect(withPepper.verify('a password', encoded)).resolves.toBe(true);
    await expect(withoutPepper.verify('a password', encoded)).resolves.toBe(false);
  });

  it('handles a very long password without truncating it', async () => {
    const long = 'a'.repeat(200) + 'DISTINCT-TAIL';
    const encoded = await hasher.hash(long);

    await expect(hasher.verify(long, encoded)).resolves.toBe(true);
    await expect(hasher.verify('a'.repeat(200), encoded)).resolves.toBe(false);
  });

  it('handles non-ASCII passwords', async () => {
    const encoded = await hasher.hash('mahál kitá 🇵🇭 pásswórd');

    await expect(hasher.verify('mahál kitá 🇵🇭 pásswórd', encoded)).resolves.toBe(true);
    await expect(hasher.verify('mahal kita 🇵🇭 password', encoded)).resolves.toBe(false);
  });
});
