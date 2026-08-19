import { LocalBreachedPasswordScreen } from '../infrastructure/breached-password-screen';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordPolicy } from './password-policy';

const policy = new PasswordPolicy(new LocalBreachedPasswordScreen());
const codes = async (password: string, context = {}) =>
  (await policy.evaluate(password, context)).map((rejection) => rejection.code);

describe('what the policy requires', () => {
  it('accepts a long passphrase', async () => {
    await expect(codes('the quiet barangay hall on tuesday')).resolves.toEqual([]);
  });

  it('rejects anything shorter than the floor', async () => {
    await expect(codes('short1!')).resolves.toContain('too-short');
    await expect(codes('a'.repeat(MIN_PASSWORD_LENGTH - 1))).resolves.toContain('too-short');
  });

  it('bounds the maximum only to stop a memory-hard hash being abused', async () => {
    await expect(codes(`${'x'.repeat(MAX_PASSWORD_LENGTH + 1)}`)).resolves.toContain('too-long');
  });

  it('accepts at least 64 characters, as NIST requires', async () => {
    await expect(codes('correct horse battery staple and then some more words for length')).resolves.toEqual([]);
  });
});

describe('what the policy deliberately does NOT require', () => {
  // These absences are the policy. Composition rules push people toward
  // predictable transformations of one password and toward writing it down;
  // NIST SP 800-63B removed them for that reason.

  it('does not require an uppercase letter', async () => {
    await expect(codes('kalesa umaga bakuran')).resolves.toEqual([]);
  });

  it('does not require a digit', async () => {
    await expect(codes('malamig na tubig sa umaga')).resolves.toEqual([]);
  });

  it('does not require a symbol', async () => {
    await expect(codes('walang sikreto sa taguan')).resolves.toEqual([]);
  });

  it('accepts spaces and Unicode without complaint', async () => {
    await expect(codes('mahál kitá kapatid 🇵🇭')).resolves.toEqual([]);
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
    await expect(codes('the quiet barangay hall', { lastName: 'Ly' })).resolves.toEqual([]);
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
