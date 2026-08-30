import { randomUUID } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { ROLE_SCOPES, StaffRole, requiresMfa } from '../domain/account';
import { normaliseEmail } from './account.repository';

/**
 * The staff directory an administrator manages.
 *
 * Three rules shape everything here, and they hold each other up:
 *
 * ── 1. AN ADMINISTRATOR NEVER SETS ANOTHER OFFICER'S PASSWORD ───────────
 *
 * A created account gets no usable verifier at all; the officer sets one
 * through the password-reset flow that already exists. This is not politeness
 * about privacy. An administrator who can set a password can sign in as that
 * officer, and every audit entry that officer's account then writes is
 * attributed to a person who did not perform the act. The whole point of a
 * hash-linked audit chain is that it says who did what, and an impersonation
 * path makes it say something false while remaining internally consistent.
 *
 * ── 2. AN ADMINISTRATOR MAY NOT CHANGE THEIR OWN ROLES ──────────────────
 *
 * Otherwise `staff:administer` is every scope, one request away, and the role
 * table becomes decoration. Refused on the account id rather than on which
 * roles are being granted, because "grant myself nothing new" is a distinction
 * that invites an off-by-one nobody notices.
 *
 * These two together close the obvious way round each other. Rule 2 stops the
 * direct route; without rule 1 an administrator could simply create an
 * account holding `staff:approve`, set its password, and sign in as it — which
 * is rule 2 with extra steps.
 *
 * ── 3. GRANTING AN MFA ROLE GRANTS NOTHING UNTIL MFA EXISTS ─────────────
 *
 * `requiresMfa` already makes sign-in demand a code for assessing, approving
 * and releasing roles, and `verifyTotp` fails closed when no secret is
 * enrolled. So an account granted one of those roles cannot sign in at all
 * until enrolment lands. That is the correct failure — the alternative is a
 * role that skips MFA because nobody had enrolled yet — and it is asserted
 * rather than assumed, because it is the kind of property that quietly stops
 * holding when someone "fixes" the null case.
 */

export interface StaffUser {
  readonly id: string;
  readonly email: string;
  readonly roles: readonly StaffRole[];
  readonly status: 'Active' | 'Disabled' | 'Pending';
  readonly mfaRequired: boolean;
  readonly mfaEnrolled: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
}

export interface StaffSession {
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

export type DirectoryRefusal =
  | { readonly ok: false; readonly reason: 'not-found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'email-taken'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'self'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not-staff'; readonly detail: string };

interface UserRow {
  id: string; email: string; disabled_at: Date | null; totp_secret_encrypted: string | null;
  created_at: Date; password_hash: string; roles: StaffRole[] | null; last_sign_in_at: Date | null;
}

const ALL_ROLES = new Set(Object.keys(ROLE_SCOPES));

export function isStaffRole(value: string): value is StaffRole {
  return ALL_ROLES.has(value);
}

/**
 * A verifier no password can produce.
 *
 * The column is `not null`, so an account must carry something. This is a
 * well-formed scrypt record whose salt and digest are random and unrelated, so
 * `verify` runs its full comparison and fails — rather than a sentinel string
 * that some future branch might treat as "no password set, let them in".
 */
export function unusablePasswordHash(): string {
  return `scrypt$32768$8$1$${randomUUID().replace(/-/g, '')}$${randomUUID().replace(/-/g, '')}`;
}

export class StaffDirectoryService {
  constructor(
    private readonly db: SqlClient,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private shape(row: UserRow): StaffUser {
    const roles = row.roles ?? [];
    return {
      id: row.id,
      email: row.email,
      roles,
      // Pending, not Active: an account whose officer has never signed in has
      // not been claimed, and showing it as Active would tell an administrator
      // that onboarding finished when it has not started.
      status: row.disabled_at !== null
        ? 'Disabled'
        : row.last_sign_in_at === null ? 'Pending' : 'Active',
      mfaRequired: requiresMfa({ kind: 'staff', roles }),
      mfaEnrolled: row.totp_secret_encrypted !== null,
      createdAt: row.created_at.toISOString(),
      lastSignInAt: row.last_sign_in_at === null ? null : row.last_sign_in_at.toISOString(),
    };
  }

  private readonly SELECT = `
    select a.id, a.email, a.disabled_at, a.totp_secret_encrypted, a.created_at, a.password_hash,
           a.last_sign_in_at,
           array_remove(array_agg(r.role), null) as roles
      from accounts a
      left join account_roles r on r.account_id = a.id
     where a.kind = 'staff'`;

  async list(filter: { role?: StaffRole; status?: string } = {}): Promise<readonly StaffUser[]> {
    const result = await this.db.query<UserRow>(
      `${this.SELECT} group by a.id order by a.email`,
    );
    return result.rows
      .map((row) => this.shape(row))
      .filter((user) => filter.role === undefined || user.roles.includes(filter.role))
      .filter((user) => filter.status === undefined || user.status === filter.status);
  }

  async byId(id: string): Promise<StaffUser | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    const result = await this.db.query<UserRow>(
      `${this.SELECT} and a.id = $1 group by a.id`, [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.shape(row);
  }

  async create(options: {
    email: string; roles: readonly StaffRole[]; actor: string; actorRole: string;
  }): Promise<{ ok: true; user: StaffUser } | DirectoryRefusal> {
    const normalised = normaliseEmail(options.email);
    const existing = await this.db.query<{ id: string }>(
      'select id from accounts where email_normalised = $1', [normalised],
    );
    if (existing.rows.length > 0) {
      return { ok: false, reason: 'email-taken', detail: 'An account already uses that address.' };
    }

    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into accounts (id, kind, email, email_normalised, password_hash, created_at)
         values ($1, 'staff', $2, $3, $4, $5)`,
        [id, options.email.trim(), normalised, unusablePasswordHash(), this.clock()],
      );
      for (const role of options.roles) {
        await tx.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
      }
      await this.audit.append({
        action: 'staff.account.created',
        subjectType: 'account',
        subjectId: id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        afterState: { email: options.email.trim(), roles: options.roles },
      }, tx);
    });

    const user = await this.byId(id);
    return user === null
      ? { ok: false, reason: 'not-found', detail: 'The account vanished after creation.' }
      : { ok: true, user };
  }

  async setRoles(options: {
    id: string; roles: readonly StaffRole[]; actor: string; actorRole: string;
  }): Promise<{ ok: true; user: StaffUser } | DirectoryRefusal> {
    if (options.id === options.actor) {
      return {
        ok: false,
        reason: 'self',
        detail: 'An administrator may not change their own roles. Ask another administrator.',
      };
    }
    const before = await this.byId(options.id);
    if (before === null) {
      return { ok: false, reason: 'not-found', detail: 'No such staff account.' };
    }

    await this.db.transaction(async (tx) => {
      // Replaced wholesale rather than diffed: the caller supplies the complete
      // set, and a diff silently keeps a role the caller meant to drop.
      await tx.query('delete from account_roles where account_id = $1', [options.id]);
      for (const role of options.roles) {
        await tx.query('insert into account_roles (account_id, role) values ($1,$2)', [options.id, role]);
      }
      await this.audit.append({
        action: 'staff.account.roles-changed',
        subjectType: 'account',
        subjectId: options.id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        beforeState: { roles: before.roles },
        afterState: { roles: options.roles },
      }, tx);
    });

    const user = await this.byId(options.id);
    return user === null
      ? { ok: false, reason: 'not-found', detail: 'No such staff account.' }
      : { ok: true, user };
  }

  async setDisabled(options: {
    id: string; disabled: boolean; actor: string; actorRole: string; reason?: string;
  }): Promise<{ ok: true; user: StaffUser } | DirectoryRefusal> {
    if (options.id === options.actor) {
      return {
        ok: false,
        reason: 'self',
        detail: 'An administrator may not disable their own account.',
      };
    }
    const before = await this.byId(options.id);
    if (before === null) {
      return { ok: false, reason: 'not-found', detail: 'No such staff account.' };
    }

    await this.db.transaction(async (tx) => {
      await tx.query(
        'update accounts set disabled_at = $1, updated_at = now() where id = $2',
        [options.disabled ? this.clock() : null, options.id],
      );
      // Disabling does NOT need the sessions revoked to take effect --
      // `AccountStatusReader.standingOf` reads `disabled_at` on every
      // authenticated request, so access stops at the next one. Revoking is a
      // separate act with its own endpoint, because "sign this person out of
      // that laptop" and "this person no longer works here" are different
      // decisions and an administrator may want either without the other.
      await this.audit.append({
        action: options.disabled ? 'staff.account.disabled' : 'staff.account.enabled',
        subjectType: 'account',
        subjectId: options.id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        beforeState: { status: before.status },
        afterState: { status: options.disabled ? 'Disabled' : 'Active', reason: options.reason ?? null },
      }, tx);
    });

    const user = await this.byId(options.id);
    return user === null
      ? { ok: false, reason: 'not-found', detail: 'No such staff account.' }
      : { ok: true, user };
  }

  /**
   * The sessions an officer currently holds.
   *
   * A session is a refresh-token FAMILY, not a row: rotation issues a new token
   * within the same family on every refresh, so counting rows would report one
   * laptop as a dozen sessions. The family id is what the access token carries
   * as `sid` and what revocation records.
   */
  async sessionsOf(id: string): Promise<readonly StaffSession[]> {
    const result = await this.db.query<{
      family_id: string; issued_at: Date; expires_at: Date; last_used_at: Date | null;
    }>(
      `select t.family_id,
              min(t.issued_at) as issued_at,
              max(t.expires_at) as expires_at,
              max(t.consumed_at) as last_used_at
         from refresh_tokens t
    left join revoked_sessions r on r.family_id = t.family_id
        where t.account_id = $1
          and t.revoked_at is null
          and r.family_id is null
          and t.expires_at > $2
     group by t.family_id
     order by min(t.issued_at) desc`,
      [id, this.clock()],
    );
    return result.rows.map((row) => ({
      sessionId: row.family_id,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    }));
  }

  async revokeSession(options: {
    id: string; sessionId: string; actor: string; actorRole: string;
  }): Promise<{ ok: true } | DirectoryRefusal> {
    const owned = await this.db.query<{ expires_at: Date }>(
      'select max(expires_at) as expires_at from refresh_tokens where account_id = $1 and family_id = $2',
      [options.id, options.sessionId],
    );
    const expiresAt = owned.rows[0]?.expires_at ?? null;
    if (expiresAt === null) {
      // Checked against the OWNER, not just the family id. Otherwise an
      // administrator could revoke any session by guessing an id, and the
      // audit entry would name the wrong account as its subject.
      return { ok: false, reason: 'not-found', detail: 'No such session for that account.' };
    }

    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into revoked_sessions (family_id, revoked_at, expires_at)
         values ($1, $2, $3) on conflict (family_id) do nothing`,
        [options.sessionId, this.clock(), expiresAt],
      );
      await this.audit.append({
        action: 'staff.session.revoked',
        subjectType: 'account',
        subjectId: options.id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        afterState: { sessionId: options.sessionId },
      }, tx);
    });
    return { ok: true };
  }
}
