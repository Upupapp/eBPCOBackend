import { PasswordHasher, TEST_SCRYPT_COST } from '../domain/password-hasher';
import { PasswordPolicy } from '../domain/password-policy';
import { InMemoryAccountRepository } from '../infrastructure/in-memory-account.repository';
import { InMemorySessionRepository } from '../infrastructure/in-memory-session.repository';
import { LocalBreachedPasswordScreen } from '../infrastructure/breached-password-screen';
import { Account, StaffRole } from '../domain/account';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';

const GOOD_PASSWORD = 'the quiet barangay hall on tuesday';

function build() {
  const accounts = new InMemoryAccountRepository();
  const sessions = new InMemorySessionRepository();
  const hasher = new PasswordHasher(TEST_SCRYPT_COST);
  const tokens = new TokenService({ signingKey: new Uint8Array(32).fill(3), sessions });
  const policy = new PasswordPolicy(new LocalBreachedPasswordScreen());
  const identity = new IdentityService(accounts, tokens, hasher, policy);
  return { identity, accounts, sessions, tokens, hasher };
}

async function seedStaff(
  accounts: InMemoryAccountRepository,
  hasher: PasswordHasher,
  roles: StaffRole[],
  totpSecret: string | null = null,
): Promise<Account> {
  const account: Account = {
    id: 'staff-1',
    kind: 'staff',
    email: 'officer@lgu.gov.ph',
    passwordHash: await hasher.hash(GOOD_PASSWORD),
    roles,
    emailVerifiedAt: new Date(),
    mobileVerifiedAt: null,
    totpSecret,
    disabledAt: null,
    createdAt: new Date(),
  };
  await accounts.save(account);
  return account;
}

describe('registration', () => {
  it('creates an applicant account', async () => {
    const { identity, accounts } = build();

    const result = await identity.register({
      email: 'Maria.Santos@Example.PH',
      password: GOOD_PASSWORD,
      firstName: 'Maria',
      lastName: 'Santos',
    });

    expect(result.accepted).toBe(true);
    const account = await accounts.findByEmail('maria.santos@example.ph');
    expect(account?.kind).toBe('applicant');
    expect(account?.roles).toEqual([]);
  });

  it('normalises the address, so one person is not two accounts', async () => {
    const { identity, accounts } = build();
    await identity.register({ email: 'A@Example.PH', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    expect(await accounts.findByEmail('a@example.ph')).not.toBeNull();
    expect(await accounts.findByEmail('  A@EXAMPLE.PH  ')).not.toBeNull();
  });

  it('answers identically whether or not the address was already registered', async () => {
    // Otherwise registration is an oracle for "does this person have a permit
    // application with this LGU".
    const { identity } = build();
    const first = await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const second = await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    expect(second).toEqual(first);
  });

  it('does not overwrite the existing account when the address is reused', async () => {
    const { identity, accounts } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const original = await accounts.findByEmail('a@b.ph');

    await identity.register({ email: 'a@b.ph', password: 'a completely different phrase', firstName: 'X', lastName: 'Y' });

    expect((await accounts.findByEmail('a@b.ph'))?.passwordHash).toBe(original?.passwordHash);
  });

  it('rejects a weak password and says why', async () => {
    // Not an enumeration signal: this is about the caller's own input.
    const { identity } = build();
    const result = await identity.register({ email: 'a@b.ph', password: 'password1234', firstName: 'A', lastName: 'B' });

    expect(result.accepted).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain('breached');
  });

  it('never stores the password', async () => {
    const { identity, accounts } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    const account = await accounts.findByEmail('a@b.ph');
    expect(JSON.stringify(account)).not.toContain('barangay');
  });
});

describe('authentication', () => {
  it('issues tokens for correct credentials', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    const outcome = await identity.authenticate('a@b.ph', GOOD_PASSWORD);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.tokens.accessToken).toBeTruthy();
      expect(outcome.tokens.refreshToken).toBeTruthy();
      expect(outcome.tokens.scopes).toContain('applications:write');
    }
  });

  it('gives one indistinguishable answer for unknown account and wrong password', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    const unknown = await identity.authenticate('nobody@b.ph', GOOD_PASSWORD);
    const wrong = await identity.authenticate('a@b.ph', 'the wrong phrase entirely');

    expect(unknown).toEqual(wrong);
    expect(unknown).toEqual({ ok: false, reason: 'rejected' });
  });

  it('spends comparable time on an unknown address as on a known one', async () => {
    // Without a decoy hash, "no such account" returns in microseconds and
    // "wrong password" in milliseconds, and the gap is a free enumeration
    // oracle for anyone with a stopwatch.
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    await identity.authenticate('warm@up.ph', 'x'); // prime the decoy

    const timeOf = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await identity.authenticate(email, 'some wrong password here');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const known = await timeOf('a@b.ph');
    const unknown = await timeOf('nobody@b.ph');
    const slower = Math.max(known, unknown);
    const faster = Math.min(known, unknown);

    expect(faster).toBeGreaterThan(0);
    expect(slower / faster).toBeLessThan(6);
  });

  it('refuses a disabled account without saying it is disabled', async () => {
    const { identity, accounts, hasher } = build();
    const staff = await seedStaff(accounts, hasher, ['evaluator']);
    await accounts.save({ ...staff, disabledAt: new Date() });

    expect(await identity.authenticate('officer@lgu.gov.ph', GOOD_PASSWORD)).toEqual({ ok: false, reason: 'rejected' });
  });

  it('upgrades a verifier hashed under weaker parameters, on sign-in', async () => {
    const { identity, accounts, hasher } = build();
    const weak = new PasswordHasher({ N: 256, r: 8, p: 1, keyLength: 32 });
    await accounts.save({
      id: 'old-1', kind: 'applicant', email: 'old@b.ph',
      passwordHash: await weak.hash(GOOD_PASSWORD), roles: [],
      emailVerifiedAt: null, mobileVerifiedAt: null, totpSecret: null,
      disabledAt: null, createdAt: new Date(),
    });

    await identity.authenticate('old@b.ph', GOOD_PASSWORD);

    expect(hasher.needsRehash((await accounts.findById('old-1'))!.passwordHash)).toBe(false);
  });
});

describe('scopes', () => {
  it('gives an applicant no staff scope at all', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const outcome = await identity.authenticate('a@b.ph', GOOD_PASSWORD);

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.tokens.scopes.some((scope) => scope.startsWith('staff:'))).toBe(false);
  });

  it('separates duties: an evaluator cannot verify a payment', async () => {
    const { identity, accounts, hasher } = build();
    await seedStaff(accounts, hasher, ['evaluator']);

    const outcome = await identity.authenticate('officer@lgu.gov.ph', GOOD_PASSWORD);

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.tokens.scopes).toContain('staff:evaluate');
    expect(outcome.tokens.scopes).not.toContain('staff:verify-payment');
    expect(outcome.tokens.scopes).not.toContain('staff:approve');
  });
});

describe('multi-factor for staff', () => {
  it('demands a second factor from a role that can assess, approve or release', async () => {
    const { identity, accounts, hasher } = build();
    await seedStaff(accounts, hasher, ['building-official'], '123456');

    expect(await identity.authenticate('officer@lgu.gov.ph', GOOD_PASSWORD)).toEqual({
      ok: false,
      reason: 'mfa-required',
    });
  });

  it('does not demand one from an applicant', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    expect((await identity.authenticate('a@b.ph', GOOD_PASSWORD)).ok).toBe(true);
  });

  it('rejects a wrong second factor', async () => {
    const { identity, accounts, hasher } = build();
    await seedStaff(accounts, hasher, ['cashier'], '123456');

    expect(await identity.authenticate('officer@lgu.gov.ph', GOOD_PASSWORD, '000000')).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('refuses a role that requires MFA but has no factor enrolled', async () => {
    // A staff member cannot disable their own MFA by clearing the secret --
    // that path fails closed.
    const { identity, accounts, hasher } = build();
    await seedStaff(accounts, hasher, ['releasing-officer'], null);

    expect(await identity.authenticate('officer@lgu.gov.ph', GOOD_PASSWORD, '123456')).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('only asks for a factor after the password is already proven', async () => {
    // Otherwise "mfa-required" tells an attacker the address belongs to staff.
    const { identity, accounts, hasher } = build();
    await seedStaff(accounts, hasher, ['building-official'], '123456');

    expect(await identity.authenticate('officer@lgu.gov.ph', 'wrong password entirely')).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});

describe('refresh', () => {
  it('rotates and keeps the session working', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const signedIn = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    if (!signedIn.ok) throw new Error('expected success');

    const refreshed = await identity.refresh(signedIn.tokens.refreshToken);

    expect(refreshed.refreshToken).not.toBe(signedIn.tokens.refreshToken);
    expect(refreshed.accessToken).toBeTruthy();
  });

  it('resolves the account from the store rather than from memory', async () => {
    // The account id travels with the rotation result, so a restarted process
    // does not silently sign everyone out.
    const { identity, accounts } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const signedIn = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    if (!signedIn.ok) throw new Error('expected success');

    const refreshed = await identity.refresh(signedIn.tokens.refreshToken);
    const account = await accounts.findByEmail('a@b.ph');

    expect(refreshed.scopes).toEqual(expect.arrayContaining(['applications:read']));
    expect(account).not.toBeNull();
  });
});

describe('password reset', () => {
  it('issues a ticket only for an account that exists', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });

    expect(await identity.beginPasswordReset('a@b.ph')).not.toBeNull();
    expect(await identity.beginPasswordReset('nobody@b.ph')).toBeNull();
  });

  it('changes the password and lets the new one in', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const ticket = await identity.beginPasswordReset('a@b.ph');

    const result = await identity.completePasswordReset(ticket!.token, 'a different quiet phrase entirely');

    expect(result.ok).toBe(true);
    expect((await identity.authenticate('a@b.ph', 'a different quiet phrase entirely')).ok).toBe(true);
    expect((await identity.authenticate('a@b.ph', GOOD_PASSWORD)).ok).toBe(false);
  });

  it('revokes every existing session', async () => {
    // If the reset happened because the account was compromised, leaving the
    // attacker's session alive defeats the entire exercise.
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const phone = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    const browser = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    if (!phone.ok || !browser.ok) throw new Error('expected success');

    const ticket = await identity.beginPasswordReset('a@b.ph');
    await identity.completePasswordReset(ticket!.token, 'a different quiet phrase entirely');

    await expect(identity.refresh(phone.tokens.refreshToken)).rejects.toBeDefined();
    await expect(identity.refresh(browser.tokens.refreshToken)).rejects.toBeDefined();
  });

  it('accepts a reset ticket only once', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const ticket = await identity.beginPasswordReset('a@b.ph');

    await identity.completePasswordReset(ticket!.token, 'a different quiet phrase entirely');
    const second = await identity.completePasswordReset(ticket!.token, 'yet another quiet phrase');

    expect(second.ok).toBe(false);
  });

  it('rejects an expired ticket', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const ticket = await identity.beginPasswordReset('a@b.ph', -1);

    expect((await identity.completePasswordReset(ticket!.token, 'a different quiet phrase')).ok).toBe(false);
  });

  it('rejects an unknown ticket', async () => {
    expect((await build().identity.completePasswordReset('made-up', 'a different quiet phrase')).ok).toBe(false);
  });

  it('applies the password policy to the new password', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const ticket = await identity.beginPasswordReset('a@b.ph');

    const result = await identity.completePasswordReset(ticket!.token, 'password1234');

    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain('breached');
  });
});

describe('sign out', () => {
  it('ends one session but not the others', async () => {
    const { identity } = build();
    await identity.register({ email: 'a@b.ph', password: GOOD_PASSWORD, firstName: 'A', lastName: 'B' });
    const phone = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    const browser = await identity.authenticate('a@b.ph', GOOD_PASSWORD);
    if (!phone.ok || !browser.ok) throw new Error('expected success');

    const claims = JSON.parse(
      Buffer.from(phone.tokens.accessToken.split('.')[1]!, 'base64url').toString(),
    ) as { sid: string };
    await identity.signOut(claims.sid);

    await expect(identity.refresh(phone.tokens.refreshToken)).rejects.toBeDefined();
    await expect(identity.refresh(browser.tokens.refreshToken)).resolves.toBeDefined();
  });
});
