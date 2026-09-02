import { randomUUID } from 'node:crypto';

import { Account, Scope, requiresMfa, scopesFor } from '../domain/account';
import { PasswordHasher } from '../domain/password-hasher';
import { PasswordResetRepository, resetTokenDigest } from './password-reset.repository';
import { PasswordPolicy, PasswordRejection } from '../domain/password-policy';
import { AccountRepository, normaliseEmail } from './account.repository';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';
import { AuditService } from '../../compliance/application/audit.service';
import {
  SecurityEntry, endedSession, failedSecondFactor, refusedSignIn, startedSession,
} from '../../compliance/domain/security-events';

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
    /**
     * Absent only in the unit specs that predate enrolment. When it is missing
     * the placeholder below still refuses everything, so a missing collaborator
     * fails closed rather than letting a second factor through unchecked.
     */
    private readonly totp?: TotpService,
    /**
     * Where security entries go. D-6, 2026-08-29.
     *
     * Optional for the same reason `totp` is -- the unit specs construct this
     * service with repositories and no database. Unlike `totp`, absence here
     * fails OPEN by design: a missing audit writer means a sign-in is not
     * recorded, not that it is refused. Locking an office out of its own system
     * because accountability could not be written is the larger harm, and the
     * e2e specs assert the entry really is written when the writer is present.
     */
    private readonly audit?: AuditService,
    private readonly onAuditFailure: (action: string, cause: unknown) => void = () => undefined,
  ) {}

  async authenticate(email: string, password: string, totp?: string): Promise<AuthenticationOutcome> {
    const account = await this.accounts.findByEmail(email);

    if (account === null) {
      await this.burnEquivalentWork(password);
      await this.recordRefusal();
      return { ok: false, reason: 'rejected' };
    }

    const passwordMatches = await this.hasher.verify(password, account.passwordHash);
    if (!passwordMatches) {
      await this.recordRefusal();
      return { ok: false, reason: 'rejected' };
    }

    // Checked after the password, not before: a disabled account must not be
    // distinguishable from a wrong password by an attacker who has neither.
    if (account.disabledAt !== null) {
      // Audited as a plain refusal, with no id, for the same reason the check
      // is ordered this way. An entry saying "this disabled account was tried"
      // would tell a reader the account exists.
      await this.recordRefusal();
      return { ok: false, reason: 'rejected' };
    }

    if (requiresMfa(account)) {
      if (totp === undefined) return { ok: false, reason: 'mfa-required' };
      if (!await this.verifyTotp(account, totp)) {
        // Named, unlike the refusals above: reaching here requires the correct
        // password, so the account's existence is not news to whoever did.
        await this.record(failedSecondFactor(account.id, account.kind));
        return { ok: false, reason: 'rejected' };
      }
    }

    // Upgrade the stored verifier if policy has moved on since it was written.
    // Done here because this is the only moment the plaintext is available.
    if (this.hasher.needsRehash(account.passwordHash)) {
      await this.accounts.updatePasswordHash(account.id, await this.hasher.hash(password));
    }

    // Recorded on the way past, after every check that could refuse. The staff
    // directory reads it to tell a created account from a claimed one; a
    // timestamp written before MFA would say an officer signed in when they
    // presented a password and nothing else.
    await this.accounts.recordSignIn(account.id, this.clock());
    await this.record(startedSession(account.id, account.kind));

    return { ok: true, tokens: await this.issueFor(account) };
  }

  /**
   * Writes a security entry, if this service was given somewhere to write it.
   *
   * Optional because the unit specs construct this service with repositories
   * and no database, and because a failure to RECORD a sign-in must never
   * become a failure to sign in -- the record is for accountability, and losing
   * one is a smaller harm than locking an office out of its own system. Any
   * failure is surfaced through the logger rather than swallowed.
   */
  private async record(entry: SecurityEntry): Promise<void> {
    if (this.audit === undefined) return;
    try {
      await this.audit.append(entry);
    } catch (cause) {
      this.onAuditFailure(entry.action, cause);
    }
  }

  private recordRefusal(): Promise<void> {
    return this.record(refusedSignIn());
  }

  /**
   * Registration.
   *
   * Returns nothing whether or not the address was already in use. The
   * verification email is what differs, and only its recipient sees that.
   */
  /**
   * Registering an applicant.
   *
   * The name and mobile number are not decoration on the password check. Until
   * 2026-08-31 they were exactly that: validated, fed to the password policy so
   * a passphrase could not contain the person's own name, and then dropped. The
   * account that resulted could never file anything — every applicant write
   * path refuses an account with no profile, and no route existed to add one —
   * so registration was not a usable way into this service.
   */
  async register(input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    mobileNumber?: string | null;
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
      // Applicants carry their name on the applicant profile, split into first
      // and last. This column is the staff member's own name (migration 034).
      fullName: null,
        mobileVerifiedAt: null,
        totpSecret: null,
        disabledAt: null,
        createdAt: now,
      }, {
        // In the same call, and therefore the same transaction. An account
        // without a profile is an account that exists and cannot act, which is
        // worse than a registration that failed because it looks like success.
        firstName: input.firstName,
        lastName: input.lastName,
        mobileNumber: input.mobileNumber ?? null,
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

    // Refresh re-reads the level too: an officer lowered to view-only must not
    // keep acting for the lifetime of a refresh token they already hold.
    const level = stored.kind === 'staff'
      ? await this.accounts.accessLevelOf(stored.id) : null;
    const scopes = scopesFor(stored, level ?? undefined);
    const access = await this.tokens.issueAccessToken({
      sub: stored.id,
      sid: rotated.familyId,
      kind: stored.kind,
      scopes,
    });

    return {
      accessToken: access.token,
      refreshToken: rotated.presented,
      expiresIn: access.expiresIn,
      scopes,
    };
  }

  async signOut(familyId: string, accountId?: string, kind?: string): Promise<void> {
    await this.tokens.endSession(familyId);
    if (accountId !== undefined) {
      await this.record(endedSession(accountId, kind ?? 'unknown', false));
    }
  }

  async signOutEverywhere(accountId: string, kind = 'unknown'): Promise<number> {
    const ended = await this.tokens.endAllSessions(accountId);
    await this.record(endedSession(accountId, kind, true));
    return ended;
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
    // The level narrows the role's scopes; it never widens them. Read at issue
    // so a change a super admin makes takes effect on the next sign-in rather
    // than being frozen into a token already held.
    const level = account.kind === 'staff'
      ? await this.accounts.accessLevelOf(account.id) : null;
    const scopes = scopesFor(account, level ?? undefined);
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

  /**
   * A real RFC 6238 check, at last.
   *
   * This was a placeholder that compared the stored secret to the presented
   * code — which is not TOTP, and which no authenticator app could ever
   * satisfy. Combined with `requiresMfa`, it meant six of nine staff roles
   * could not sign in at all: assessors, cashiers, building officials,
   * releasing officers, administrators and super-admins. Nothing caught it
   * because every test mints its tokens directly rather than signing in.
   *
   * Still fails closed when no secret is enrolled, and now also when the
   * enrolment service is absent — a missing collaborator must not become an
   * accepted code.
   */
  private async verifyTotp(account: Account, presented: string): Promise<boolean> {
    if (account.totpSecret === null) return false;
    if (this.totp === undefined) return false;
    return this.totp.verifyAtSignIn({ accountId: account.id, code: presented });
  }

}
