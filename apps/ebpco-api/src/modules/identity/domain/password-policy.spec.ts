import { LocalBreachedPasswordScreen } from '../infrastructure/breached-password-screen';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordPolicy } from './password-policy';

const policy = new PasswordPolicy(new LocalBreachedPasswordScreen());
const codes = async (password: string, context = {}) =>
  (await policy.evaluate(password, context)).map((rejection) => rejection.code);

describe('what the policy requires', () => {
  it('accepts a long, fully compliant passphrase', async () => {
    await expect(codes('The quiet Barangay hall, open Tuesday at 3pm!')).resolves.toEqual([]);
  });

  it('rejects anything shorter than the floor', async () => {
    await expect(codes('short1!')).resolves.toContain('too-short');
    await expect(codes('a'.repeat(MIN_PASSWORD_LENGTH - 1))).resolves.toContain('too-short');
  });

  it('bounds the maximum only to stop a memory-hard hash being abused', async () => {
    await expect(codes(`${'x'.repeat(MAX_PASSWORD_LENGTH + 1)}`)).resolves.toContain('too-long');
  });

  it('accepts at least 64 characters, as NIST requires', async () => {
    await expect(
      codes('Correct horse battery staple, and then some more words for length! 42'),
    ).resolves.toEqual([]);
  });
});

describe('what the policy requires: composition', () => {
  // A deliberate product decision, made alongside (not despite) NIST SP
  // 800-63B's own preference against composition rules — see this file's
  // top-of-file comment. Each class is its own rejection code so the client
  // can show its own checklist item for it, independent of the others.
  const base = 'aaaaaaaaaaaa'; // 12 chars, deliberately fails everything below

  it('rejects a password with no uppercase letter', async () => {
    await expect(codes(`${base}1!`)).resolves.toContain('missing-uppercase');
  });

  it('rejects a password with no lowercase letter', async () => {
    await expect(codes('AAAAAAAAAAAA1!')).resolves.toContain('missing-lowercase');
  });

  it('rejects a password with no digit', async () => {
    await expect(codes('Aaaaaaaaaaaa!')).resolves.toContain('missing-digit');
  });

  it('rejects a password with no punctuation', async () => {
    await expect(codes('Aaaaaaaaaaaa1')).resolves.toContain('missing-punctuation');
  });

  it('accepts a Unicode letter as satisfying uppercase/lowercase', async () => {
    // NIST requires accepting all Unicode; a composition rule that only
    // recognised A-Z/a-z would silently reject a perfectly good accented
    // letter while still counting it toward length.
    await expect(codes('Ñañaña naman 123!')).resolves.toEqual([]);
  });

  it('treats a symbol as punctuation even outside \\p{P} (e.g. $, +, ~)', async () => {
    await expect(codes('Aaaaaaaaaaaa1$')).resolves.toEqual([]);
  });
});

describe('screening against what attackers already have', () => {
  it.each(['password1234', 'qwertyuiop12', 'letmein12345', 'iloveyou1234'])(
    'rejects the breached password %s',
    async (password) => {
      await expect(codes(password)).resolves.toContain('breached');
    },
  );

  it('is not fooled by capitalisation', async () => {
    // Attackers try capitalisation variants first.
    await expect(codes('Password1234')).resolves.toContain('breached');
    await expect(codes('PASSWORD1234')).resolves.toContain('breached');
  });

  it('is not fooled by padding a known password to reach the length floor', async () => {
    await expect(codes('password!!!!!!!!')).resolves.toContain('breached');
  });

  it('rejects a single repeated character', async () => {
    await expect(codes('aaaaaaaaaaaaaaaa')).resolves.toContain('repetitive');
  });

  it('rejects a simple sequence', async () => {
    await expect(codes('abcdefghijklmnop')).resolves.toContain('sequential');
    // Descending. Not '9876543210987654', which restarts at 9 and so is not
    // one sequence -- that expectation was mine, and it was wrong.
    await expect(codes('ponmlkjihgfedcba')).resolves.toContain('sequential');
  });
});

describe('screening against context', () => {
  it('rejects a password containing the applicant’s own name', async () => {
    await expect(
      codes('mariasantos12345', { firstName: 'Maria', lastName: 'Santos' }),
    ).resolves.toContain('context-specific');
  });

  it('rejects a password containing the local part of their email', async () => {
    await expect(
      codes('mariasantos-permit', { email: 'mariasantos@example.ph' }),
    ).resolves.toContain('context-specific');
  });

  it('rejects a password naming this service', async () => {
    await expect(codes('ebpco-application-1')).resolves.toContain('context-specific');
    await expect(codes('building permit 2026')).resolves.toContain('context-specific');
  });

  it('ignores a context value too short to be distinctive', async () => {
    // Rejecting every password containing a two-letter surname would reject
    // most passphrases.
    await expect(codes('The Quiet Barangay Hall, 2026!', { lastName: 'Ly' })).resolves.toEqual([]);
  });
});

describe('how rejections are reported', () => {
  it('explains what to do instead, not merely what is wrong', async () => {
    const rejections = await policy.evaluate('short');

    expect(rejections[0]?.message).toMatch(/longer phrase/i);
  });

  it('stops after length so an applicant is not given five problems at once', async () => {
    // Everything else is pointless advice on a password that is too short.
    await expect(codes('abc')).resolves.toEqual(['too-short']);
  });

  it('reports every applicable problem for a long-enough password', async () => {
    const result = await codes('password1234', { email: 'password@example.ph' });

    expect(result).toContain('breached');
    expect(result).toContain('context-specific');
  });
});
