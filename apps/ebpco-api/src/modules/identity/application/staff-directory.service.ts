import { randomUUID } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { ROLE_SCOPES, StaffRole, requiresMfa } from '../domain/account';
import { mayRemoveSuperAdmin } from '../domain/super-admin-floor';
import { normaliseEmail } from './account.repository';
import { SUPER_ADMIN_ONLY, holdsSuperAdmin } from './super-admin-guard';

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
 *
 * ── 4. ONLY A SUPER ADMIN ACTS ON A SUPER ADMIN ─────────────────────────
 *
 * Granting or removing `super-admin`, and disabling or enabling an account
 * that holds it. See `super-admin-guard.ts`: without it an administrator is a
 * super admin one request away, by way of a second account.
 */

export interface StaffUser {
  readonly id: string;
  readonly email: string;
  /** The officer's own name, as the office entered it. Null when never recorded. */
  readonly fullName: string | null;
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
  | { readonly ok: false; readonly reason: 'not-staff'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not-permitted'; readonly detail: string };

/**
 * What removing a staff account did: `deleted` — it had never acted, so the
 * row is gone and its address is free again — or `retired` — its name is on
 * decisions, so it is kept, disabled for good and hidden from the directory.
 */
export type RemovalMode = 'deleted' | 'retired';

interface UserRow {
  id: string; email: string; full_name: string | null; disabled_at: Date | null;
  totp_secret_encrypted: string | null; created_at: Date; password_hash: string;
  roles: StaffRole[] | null; last_sign_in_at: Date | null;
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
      fullName: row.full_name,
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

  // A removed account (migration 057) is not in the directory: it can never
  // sign in again, and it is kept only so its decisions stay attributed.
  private readonly SELECT = `
    select a.id, a.email, a.full_name, a.disabled_at, a.totp_secret_encrypted, a.created_at,
           a.password_hash, a.last_sign_in_at,
           array_remove(array_agg(r.role), null) as roles
      from accounts a
      left join account_roles r on r.account_id = a.id
     where a.kind = 'staff' and a.removed_at is null`;

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
    email: string; fullName?: string; roles: readonly StaffRole[]; actor: string; actorRole: string;
  }): Promise<{ ok: true; user: StaffUser } | DirectoryRefusal> {
    const fullName = options.fullName?.trim() || null;
    if (options.roles.includes('super-admin') && !(await holdsSuperAdmin(this.db, options.actor))) {
      return { ok: false, reason: 'not-permitted', detail: SUPER_ADMIN_ONLY };
    }
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
        `insert into accounts (id, kind, email, email_normalised, password_hash, full_name, created_at)
         values ($1, 'staff', $2, $3, $4, $5, $6)`,
        [id, options.email.trim(), normalised, unusablePasswordHash(), fullName, this.clock()],
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
        afterState: { email: options.email.trim(), fullName, roles: options.roles },
      }, tx);
    });

    const user = await this.byId(id);
    return user === null
      ? { ok: false, reason: 'not-found', detail: 'The account vanished after creation.' }
      : { ok: true, user };
  }

  /**
   * Whether the service still has someone who can administer it, without this
   * account.
   *
   * Asked by demotion and by disabling, from one place, because they differ in
   * every respect except the only one that matters: afterwards, that account
   * can no longer administer. Erasure asks it too, and refuses staff accounts
   * outright for a separate reason.
   *
   * This is the one failure that cannot be repaired from inside the product.
   * Every other refusal here protects a record; this protects the ability to
   * grant the role back at all, and recovery without it means someone with
   * database credentials — at which point the access control has stopped being
   * the mechanism.
   */
  private async survivesWithout(accountId: string): Promise<{ ok: true } | DirectoryRefusal> {
    const { rows } = await this.db.query<{ id: string }>(
      `select a.id from accounts a
         join account_roles r on r.account_id = a.id
        where r.role = 'super-admin' and a.disabled_at is null`,
    );
    const decision = mayRemoveSuperAdmin(
      { enabledSuperAdmins: rows.map((row) => row.id) }, accountId);

    return decision.ok ? { ok: true } : { ok: false, reason: 'self', detail: decision.reason };
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
    // Demotion is one of the three ways to remove the last super admin, and
    // they must answer identically — see `survivesWithout`. Asked first: it is
    // the more fundamental refusal, whoever is asking.
    if (before.roles.includes('super-admin') && !options.roles.includes('super-admin')) {
      const floor = await this.survivesWithout(options.id);
      if (!floor.ok) return floor;
    }
    if ((before.roles.includes('super-admin') || options.roles.includes('super-admin'))
      && !(await holdsSuperAdmin(this.db, options.actor))) {
      return { ok: false, reason: 'not-permitted', detail: SUPER_ADMIN_ONLY };
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
    // Disabling is the second way. ENABLING is not: it can only add an
    // administrator, never remove the last one.
    if (options.disabled) {
      const floor = await this.survivesWithout(options.id);
      if (!floor.ok) return floor;
    }
    if (before.roles.includes('super-admin') && !(await holdsSuperAdmin(this.db, options.actor))) {
      return { ok: false, reason: 'not-permitted', detail: SUPER_ADMIN_ONLY };
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
   * Correcting the name an officer's decisions are shown under.
   *
   * Unlike the address it moves no credential — nobody signs in with a name or
   * receives a recovery ticket at one — so it needs none of the re-verification
   * that keeps the address fixed. A super admin's name is still the super
   * admin's to change (rule 4), except their own.
   */
  async rename(options: {
    id: string; fullName: string; actor: string; actorRole: string;
  }): Promise<{ ok: true; user: StaffUser } | DirectoryRefusal> {
    const before = await this.byId(options.id);
    if (before === null) {
      return { ok: false, reason: 'not-found', detail: 'No such staff account.' };
    }
    if (before.roles.includes('super-admin') && options.id !== options.actor
      && !(await holdsSuperAdmin(this.db, options.actor))) {
      return { ok: false, reason: 'not-permitted', detail: SUPER_ADMIN_ONLY };
    }
    const fullName = options.fullName.trim();
    if (fullName === before.fullName) return { ok: true, user: before };

    await this.db.transaction(async (tx) => {
      await tx.query(
        'update accounts set full_name = $1, updated_at = now() where id = $2', [fullName, options.id]);
      await this.audit.append({
        action: 'staff.account.renamed',
        subjectType: 'account',
        subjectId: options.id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        beforeState: { fullName: before.fullName },
        afterState: { fullName },
      }, tx);
    });

    const user = await this.byId(options.id);
    return user === null
      ? { ok: false, reason: 'not-found', detail: 'No such staff account.' }
      : { ok: true, user };
  }

  /**
   * A super admin removing a staff account from the directory (owner request,
   * 2026-09-26).
   *
   * The same two refusals as disabling — not yourself, not the last super
   * admin — plus one more: only a super admin may do it. An administrator can
   * already disable an account; removing it for good is a step further, and
   * the owner gave it to the super admin alone.
   *
   * An account that never acted (no audit entry of its own) is deleted, which
   * also frees its address for a correctly spelled replacement. One that did
   * act is RETIRED instead: its name is on sign-ins, evaluations or decisions,
   * and deleting it would leave those attributed to nobody — the reason
   * erasure refuses staff accounts. A foreign key the account turns out to be
   * named on is treated the same way: the delete is rolled back to a savepoint
   * and the account retired.
   */
  async remove(options: {
    id: string; actor: string; actorRole: string;
  }): Promise<{ ok: true; mode: RemovalMode } | DirectoryRefusal> {
    if (options.id === options.actor) {
      return { ok: false, reason: 'self', detail: 'You cannot delete your own account.' };
    }
    if (!(await holdsSuperAdmin(this.db, options.actor))) {
      return { ok: false, reason: 'not-permitted', detail: 'Only a super admin can delete a staff account.' };
    }
    const before = await this.byId(options.id);
    if (before === null) {
      return { ok: false, reason: 'not-found', detail: 'No such staff account.' };
    }
    // Removal is the third way to lose the last super admin — see
    // `survivesWithout`.
    if (before.roles.includes('super-admin')) {
      const floor = await this.survivesWithout(options.id);
      if (!floor.ok) return floor;
    }

    const acted = await this.db.query<{ acted: boolean }>(
      'select exists (select 1 from audit_events where actor_account_id = $1) as acted', [options.id]);

    const mode = await this.db.transaction<RemovalMode>(async (tx) => {
      let outcome: RemovalMode = 'retired';
      if (acted.rows[0]?.acted !== true) {
        await tx.query('savepoint remove_staff_account');
        try {
          await tx.query('delete from accounts where id = $1', [options.id]);
          outcome = 'deleted';
        } catch (error) {
          // 23503: something still names this account. Keep it, retired.
          if ((error as { code?: string }).code !== '23503') throw error;
          await tx.query('rollback to savepoint remove_staff_account');
        }
      }
      if (outcome === 'retired') {
        const now = this.clock();
        await tx.query(
          `update accounts
              set disabled_at = coalesce(disabled_at, $2), removed_at = $2, removed_by = $3, updated_at = now()
            where id = $1`,
          [options.id, now, options.actor],
        );
      }
      await this.audit.append({
        action: 'staff.account.removed',
        subjectType: 'account',
        subjectId: options.id,
        outcome: 'allowed',
        actorAccountId: options.actor,
        actorRole: options.actorRole,
        beforeState: { email: before.email, fullName: before.fullName, roles: before.roles, status: before.status },
        afterState: { mode: outcome },
      }, tx);
      return outcome;
    });

    return { ok: true, mode };
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
