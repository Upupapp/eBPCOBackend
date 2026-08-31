import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { SECURITY_ACTIONS } from '../../compliance/domain/security-events';
import { AccessLevel, NO_ACCESS, StaffAccess } from '../domain/staff-access';
import { mayRemoveSuperAdmin } from '../domain/super-admin-floor';

export type Refusal = { readonly ok: false; readonly reason: string; readonly detail: string };
export type Outcome = { readonly ok: true } | Refusal;

export interface Actor {
  readonly accountId: string;
  readonly role: string;
}

/**
 * Reading and changing what a staff account may work on.
 *
 * Two responsibilities that look separate and are not: the read is what every
 * query in the service filters by, and the write is the only thing that can
 * change it. Keeping them together means the shape returned by `accessFor` and
 * the shape written by `assign` cannot drift apart — which they would, in two
 * files, the first time someone added a field.
 */
export class StaffAccessService {
  constructor(
    private readonly db: SqlClient,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * What this account may work on.
   *
   * Returns NO_ACCESS for an account with no assignment — never "everything".
   * An unassigned officer seeing nothing is a support call; an unassigned
   * officer seeing every permit type is the failure this whole table exists to
   * prevent, and it is the one a missing row would produce if absence were read
   * as absence of restriction.
   */
  async accessFor(accountId: string): Promise<StaffAccess> {
    const level = await this.db.query<{ level: AccessLevel }>(
      'select level from staff_access where account_id = $1', [accountId]);
    if (level.rows.length === 0) return NO_ACCESS;

    const forms = await this.db.query<{ permit_type: string }>(
      `select p.permit_type from staff_permit_access p
        where p.account_id = $1
        order by p.permit_type`,
      [accountId],
    );

    return {
      level: level.rows[0]!.level,
      permitTypes: forms.rows.map((row) => row.permit_type),
    };
  }

  /**
   * The same answer, for the live permit types only.
   *
   * A retired permit type stays in the allow-list — the grant explains why an
   * officer once had access and deleting it would erase that — but it must not
   * widen what they can reach today. Callers filtering live work use this.
   */
  async liveAccessFor(accountId: string): Promise<StaffAccess> {
    const access = await this.accessFor(accountId);
    if (access.permitTypes.length === 0) return access;

    const live = await this.db.query<{ permit_type: string }>(
      `select permit_type from permit_types
        where retired_at is null and permit_type = any($1::text[])`,
      [[...access.permitTypes]],
    );
    return { level: access.level, permitTypes: live.rows.map((row) => row.permit_type) };
  }

  /**
   * Change the level, recording what it was.
   *
   * `before`/`after` rather than just the new value: "Ana is now view-edit" is a
   * fact, and "Ana was raised from view to view-edit by Paul on Tuesday" is the
   * answer to the question a reviewer actually asks.
   */
  async setLevel(accountId: string, level: AccessLevel, actor: Actor): Promise<Outcome> {
    const before = await this.db.query<{ level: AccessLevel }>(
      'select level from staff_access where account_id = $1', [accountId]);
    const previous = before.rows[0]?.level ?? null;
    if (previous === level) return { ok: true };

    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into staff_access (account_id, level, assigned_by, assigned_at)
         values ($1,$2,$3,$4)
         on conflict (account_id)
         do update set level = excluded.level, assigned_by = excluded.assigned_by,
                       assigned_at = excluded.assigned_at`,
        [accountId, level, actor.accountId, this.clock()],
      );
      await this.audit.append({
        action: SECURITY_ACTIONS.accessLevelChanged,
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        beforeState: { level: previous },
        afterState: { level },
      }, tx);
    });

    return { ok: true };
  }

  /**
   * Replace the allow-list, recording both sides.
   *
   * A replacement rather than add/remove calls, because "which forms may this
   * officer work on" has one answer and two operations invite a sequence that
   * is briefly wrong. Refuses an empty list: an officer assigned no forms can
   * reach nothing, and if that is the intention the account should be disabled
   * where it is visible, not left looking active and doing nothing.
   */
  async setForms(
    accountId: string, permitTypes: readonly string[], actor: Actor,
  ): Promise<Outcome> {
    const wanted = [...new Set(permitTypes)].sort();
    if (wanted.length === 0) {
      return {
        ok: false, reason: 'no-forms',
        detail: 'Assign at least one permit type, or disable the account instead. '
          + 'An empty allow-list leaves an active account able to reach nothing.',
      };
    }

    const known = await this.db.query<{ permit_type: string }>(
      'select permit_type from permit_types where permit_type = any($1::text[])', [wanted]);
    if (known.rows.length !== wanted.length) {
      const found = new Set(known.rows.map((row) => row.permit_type));
      return {
        ok: false, reason: 'unknown-permit-type',
        // Names them: this is a signed-in super admin acting on internal keys,
        // not an anonymous caller probing which types exist.
        detail: `Not permit types: ${wanted.filter((t) => !found.has(t)).join(', ')}.`,
      };
    }

    const before = await this.db.query<{ permit_type: string }>(
      'select permit_type from staff_permit_access where account_id = $1 order by permit_type',
      [accountId]);
    const previous = before.rows.map((row) => row.permit_type);

    await this.db.transaction(async (tx) => {
      await tx.query('delete from staff_permit_access where account_id = $1', [accountId]);
      for (const permitType of wanted) {
        await tx.query(
          'insert into staff_permit_access (account_id, permit_type, granted_by) values ($1,$2,$3)',
          [accountId, permitType, actor.accountId]);
      }
      await this.audit.append({
        action: SECURITY_ACTIONS.accessFormsChanged,
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        beforeState: { permitTypes: previous },
        afterState: { permitTypes: wanted },
      }, tx);
    });

    return { ok: true };
  }

  /**
   * Whether removing this account's super-admin standing is survivable.
   *
   * Asked here rather than at each call site, so demote, disable and erase get
   * one answer. The count is of ENABLED super admins: a disabled one cannot
   * sign in, so it cannot be the one that saves you.
   */
  async mayLoseSuperAdmin(accountId: string): Promise<Outcome> {
    const { rows } = await this.db.query<{ account_id: string }>(
      `select a.id as account_id from accounts a
         join account_roles r on r.account_id = a.id
        where r.role = 'super-admin' and a.disabled_at is null`,
    );
    const decision = mayRemoveSuperAdmin(
      { enabledSuperAdmins: rows.map((row) => row.account_id) }, accountId);

    return decision.ok
      ? { ok: true }
      : { ok: false, reason: 'last-super-admin', detail: decision.reason };
  }
}
