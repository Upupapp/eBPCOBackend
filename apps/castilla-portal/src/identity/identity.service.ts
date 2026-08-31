import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';
import { hashPassword, verifyPassword } from './password';
import { Scope, StaffRole, scopesFor } from './roles';

export interface Principal {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: StaffRole;
  readonly scopes: readonly Scope[];
}

export type SignInResult =
  | { readonly ok: true; readonly token: string; readonly principal: Principal }
  | { readonly ok: false };

const SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class IdentityService {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * Sign in.
   *
   * The result type carries NO reason. A wrong password, an unknown address, a
   * disabled account and a locked one all return the same `{ ok: false }`,
   * because any difference between them is an oracle: an attacker who can tell
   * 'no such account' from 'wrong password' has enumerated your staff. The real
   * reason is written to `sign_in_attempts` for the operator.
   */
  async signIn(email: string, password: string, now = new Date()): Promise<SignInResult> {
    const { rows } = await this.db.query<{
      id: string; email: string; display_name: string; role: StaffRole;
      password_hash: string; disabled_at: Date | null; locked_until: Date | null;
    }>(
      `select id, email, display_name, role, password_hash, disabled_at, locked_until
         from staff_accounts where lower(email) = lower($1)`, [email]);
    const account = rows[0];

    // No account: still run a full verification against a well-formed but
    // unrelated record, so the response takes the same time as a real failure.
    if (account === undefined) {
      await verifyPassword(password, 'scrypt$32768$8$1$00$00');
      await this.recordAttempt(email, false, 'no such account');
      return { ok: false };
    }
    if (account.disabled_at !== null) {
      await verifyPassword(password, account.password_hash);
      await this.recordAttempt(email, false, 'account disabled');
      return { ok: false };
    }
    if (account.locked_until !== null && account.locked_until.getTime() > now.getTime()) {
      await verifyPassword(password, account.password_hash);
      await this.recordAttempt(email, false, 'locked out');
      return { ok: false };
    }

    if (!await verifyPassword(password, account.password_hash)) {
      await this.recordFailure(account.id, now);
      await this.recordAttempt(email, false, 'wrong password');
      return { ok: false };
    }

    await this.db.query(
      `update staff_accounts set failed_attempts = 0, locked_until = null where id = $1`,
      [account.id]);
    await this.recordAttempt(email, true, null);

    // 32 random bytes, returned once and never stored. Only its sha256 is kept,
    // so a database dump is not a set of live credentials.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
    await this.db.query(
      `insert into staff_sessions (token_hash, account_id, issued_at, expires_at)
       values ($1,$2,$3,$4)`,
      [hashToken(token), account.id, now, expiresAt]);

    return {
      ok: true, token,
      principal: {
        accountId: account.id, email: account.email, displayName: account.display_name,
        role: account.role, scopes: scopesFor(account.role),
      },
    };
  }

  /**
   * Resolve a bearer token to a principal, or null.
   *
   * The session row IS the session. There is no signed claim to trust and no
   * denylist to remember to consult — a deleted row cannot authenticate, and no
   * future code path can forget to check.
   */
  async authenticate(token: string | undefined, now = new Date()): Promise<Principal | null> {
    if (token === undefined || token === '') return null;

    const { rows } = await this.db.query<{
      account_id: string; email: string; display_name: string;
      role: StaffRole; expires_at: Date; disabled_at: Date | null;
    }>(
      `select s.account_id, a.email, a.display_name, a.role, s.expires_at, a.disabled_at
         from staff_sessions s
         join staff_accounts a on a.id = s.account_id
        where s.token_hash = $1`, [hashToken(token)]);

    const session = rows[0];
    if (session === undefined) return null;
    if (session.expires_at.getTime() <= now.getTime()) return null;
    // Disabling an account must take effect on the next request, not when its
    // session happens to expire.
    if (session.disabled_at !== null) return null;

    await this.db.query(
      'update staff_sessions set last_seen_at = $2 where token_hash = $1',
      [hashToken(token), now]);

    return {
      accountId: session.account_id, email: session.email,
      displayName: session.display_name, role: session.role,
      scopes: scopesFor(session.role),
    };
  }

  /** Sign out. The row is deleted, so replaying the token cannot work. */
  async signOut(token: string): Promise<void> {
    await this.db.query('delete from staff_sessions where token_hash = $1', [hashToken(token)]);
  }

  /** Every session for one account — used when an account is disabled. */
  async signOutEverywhere(accountId: string): Promise<void> {
    await this.db.query('delete from staff_sessions where account_id = $1', [accountId]);
  }

  async createAccount(
    email: string, displayName: string, role: StaffRole, password: string,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into staff_accounts (email, display_name, role, password_hash)
       values ($1,$2,$3,$4) returning id`,
      [email, displayName, role, await hashPassword(password)]);
    return rows[0]!.id;
  }

  private async recordFailure(accountId: string, now: Date): Promise<void> {
    await this.db.query(
      `update staff_accounts
          set failed_attempts = failed_attempts + 1,
              locked_until = case when failed_attempts + 1 >= $2
                                  then $3::timestamptz else locked_until end
        where id = $1`,
      [accountId, MAX_FAILURES, new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000)]);
  }

  private async recordAttempt(
    email: string, succeeded: boolean, reason: string | null,
  ): Promise<void> {
    await this.db.query(
      'insert into sign_in_attempts (email, succeeded, reason) values ($1,$2,$3)',
      [email, succeeded, reason]);
  }
}
