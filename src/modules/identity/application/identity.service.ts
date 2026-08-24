import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Account, Scope, requiresMfa, scopesFor } from '../domain/account';
import { PasswordHasher } from '../domain/password-hasher';
import { PasswordResetRepository, resetTokenDigest } from './password-reset.repository';
import { PasswordPolicy, PasswordRejection } from '../domain/password-policy';
import { AccountRepository, normaliseEmail } from './account.repository';
import { TokenService } from './token.service';

/**
 * Sign-in, registration, recovery and revocation.
 *
 * Every path through this class is written so that an unauthenticated caller
 * learns nothing about who has an account here. That constraint shapes the
 * return types: `register` and `beginPasswordReset` return nothing at all, and
 * `authenticate` has one failure value rather than several.
 */

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scopes: readonly Scope[];
}

export type AuthenticationOutcome =
  | { readonly ok: true; readonly tokens: IssuedTokens }
  /**
   * One value for "no such account", "wrong password" and "disabled". A caller
   * who could distinguish them could enumerate the applicant register.
   */
  | { readonly ok: false; readonly reason: 'rejected' }
  /**
   * Distinguishable only because the caller has ALREADY proven the password.
   * Telling them a second factor is required reveals nothing further.
   */
  | { readonly ok: false; readonly reason: 'mfa-required' };

export interface PasswordResetTicket {
  readonly token: string;
  readonly expiresAt: Date;
}

export class IdentityService {
  /**
   * A verifier for an account that does not exist, hashed once at construction.
   *
   * Verifying against it when the email is unknown makes the unknown-account
   * path do the same expensive work as the wrong-password path. Without it,
   * "no such account" returns in microseconds and "wrong password" in ~100ms,
   * and the difference is a free account-enumeration oracle.
   */
  private decoyHash: string | null = null;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly tokens: TokenService,
    private readonly hasher: PasswordHasher,
    private readonly policy: PasswordPolicy,
    private readonly resetTickets: PasswordResetRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async authenticate(email: string, password: string, totp?: string): Promise<AuthenticationOutcome> {
    const account = await this.accounts.findByEmail(email);

    if (account === null) {
      await this.burnEquivalentWork(password);
      return { ok: false, reason: 'rejected' };
    }

    const passwordMatches = await this.hasher.verify(password, account.passwordHash);
    if (!passwordMatches) return { ok: false, reason: 'rejected' };

    // Checked after the password, not before: a disabled account must not be
    // distinguishable from a wrong password by an attacker who has neither.
    if (account.disabledAt !== null) return { ok: false, reason: 'rejected' };

    if (requiresMfa(account)) {
      if (totp === undefined) return { ok: false, reason: 'mfa-required' };
      if (!this.verifyTotp(account, totp)) return { ok: false, reason: 'rejected' };
    }

    // Upgrade the stored verifier if policy has moved on since it was written.
    // Done here because this is the only moment the plaintext is available.
    if (this.hasher.needsRehash(account.passwordHash)) {
      await this.accounts.updatePasswordHash(account.id, await this.hasher.hash(password));
    }

    return { ok: true, tokens: await this.issueFor(account) };
  }

  /**
   * Registration.
   *
   * Returns nothing whether or not the address was already in use. The
   * verification email is what differs, and only its recipient sees that.
   */
  async register(input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }): Promise<{ accepted: boolean; rejections: readonly PasswordRejection[] }> {
    // The password is checked before the address is looked up, because a weak
    // password must be reported to the person choosing it -- that is not an
    // enumeration signal, it is about their own input.
    const rejections = await this.policy.evaluate(input.password, {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
    });
    if (rejections.length > 0) return { accepted: false, rejections };

    const existing = await this.accounts.findByEmail(input.email);
    if (existing === null) {
      const now = this.clock();
      await this.accounts.save({
        id: randomUUID(),
        kind: 'applicant',
        email: normaliseEmail(input.email),
        passwordHash: await this.hasher.hash(input.password),
        roles: [],
        emailVerifiedAt: null,
        mobileVerifiedAt: null,
        totpSecret: null,
        disabledAt: null,
        createdAt: now,
      });
    }

    // Identical either way.
    return { accepted: true, rejections: [] };
  }

  async refresh(presentedRefreshToken: string): Promise<IssuedTokens> {
    const rotated = await this.tokens.rotate(presentedRefreshToken);
    const stored = await this.accounts.findById(rotated.accountId);
    if (stored === null || stored.disabledAt !== null) {
      await this.tokens.endSession(rotated.familyId);
      throw new Error('account is no longer active');
    }

    const access = await this.tokens.issueAccessToken({
      sub: stored.id,
      sid: rotated.familyId,
      kind: stored.kind,
      scopes: scopesFor(stored),
    });

    return {
      accessToken: access.token,
      refreshToken: rotated.presented,
      expiresIn: access.expiresIn,
      scopes: scopesFor(stored),
    };
  }

  async signOut(familyId: string): Promise<void> {
    await this.tokens.endSession(familyId);
  }

  async signOutEverywhere(accountId: string): Promise<number> {
    return this.tokens.endAllSessions(accountId);
  }

  /**
   * Begins account recovery. Returns a ticket only when the account exists;
   * the caller must not reveal which case occurred.
   */
  async beginPasswordReset(email: string, ttlSeconds = 900): Promise<PasswordResetTicket | null> {
    const account = await this.accounts.findByEmail(email);
    if (account === null) return null;

    const token = randomUUID();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    // Only the digest is stored. The token goes to the applicant by email, and
    // a leak of this store should not hand over working reset links.
    await this.resetTickets.issue(resetTokenDigest(token), account.id, now, expiresAt);
    return { token, expiresAt };
  }

  /**
   * Completes recovery.
   *
   * Succeeding revokes every existing session. If the reset was triggered
   * because the account was compromised, leaving the attacker's session alive
   * would defeat the entire exercise.
   */
  async completePasswordReset(
    token: string,
    newPassword: string,
  ): Promise<{ ok: boolean; rejections: readonly PasswordRejection[] }> {
    const now = this.clock();
    // Redeemed first, and atomically. Checking the ticket and then marking it
    // used lets two requests arriving together both pass — which for a password
    // reset means two people setting a password on one account.
    const ticket = await this.resetTickets.redeem(resetTokenDigest(token), now);
    if (ticket === null) return { ok: false, rejections: [] };

    const account = await this.accounts.findById(ticket.accountId);
    if (account === null) return { ok: false, rejections: [] };

    const rejections = await this.policy.evaluate(newPassword, { email: account.email });
    if (rejections.length > 0) {
      // The ticket is already spent. That is deliberate: a weak password is a
      // failed attempt at a reset, not a free retry, and leaving the ticket
      // live would let an attacker who obtained one probe the password policy
      // indefinitely. The applicant requests a new link, which costs them one
      // email and costs an attacker the whole exercise.
      return { ok: false, rejections };
    }

    await this.accounts.updatePasswordHash(account.id, await this.hasher.hash(newPassword));
    // Every session, everywhere. Someone resetting a password is often doing it
    // because they think somebody else has it.
    await this.tokens.endAllSessions(account.id);

    return { ok: true, rejections: [] };
  }

  private async issueFor(account: Account): Promise<IssuedTokens> {
    const session = await this.tokens.startSession(account.id);
    const scopes = scopesFor(account);
    const access = await this.tokens.issueAccessToken({
      sub: account.id,
      sid: session.familyId,
      kind: account.kind,
      scopes,
    });
    return {
      accessToken: access.token,
      refreshToken: session.presented,
      expiresIn: access.expiresIn,
      scopes,
    };
  }

  /**
   * Spend roughly the same time on an unknown address as on a known one.
   */
  private async burnEquivalentWork(password: string): Promise<void> {
    this.decoyHash ??= await this.hasher.hash(randomUUID());
    await this.hasher.verify(password, this.decoyHash);
  }

  private verifyTotp(account: Account, presented: string): boolean {
    // Placeholder shape only: TOTP verification arrives with staff
    // provisioning. It is constant-time even so, because a timing difference
    // here would leak the code one digit at a time.
    if (account.totpSecret === null) return false;
    const expected = Buffer.from(account.totpSecret, 'utf8');
    const candidate = Buffer.from(presented, 'utf8');
    if (expected.length !== candidate.length) return false;
    return timingSafeEqual(expected, candidate);
  }
}
