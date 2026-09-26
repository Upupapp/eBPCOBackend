import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { SECURITY_ACTIONS } from '../../compliance/domain/security-events';
import { EVALUATION_STAGES, EvaluationStage, isEvaluationStage } from '../../applications/domain/evaluation-stages';
import { AccessLevel, NO_ACCESS, StaffAccess } from '../domain/staff-access';
import { SUPER_ADMIN_ONLY, holdsSuperAdmin } from './super-admin-guard';

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
    const guarded = await this.superAdminGuard(accountId, actor);
    if (guarded !== null) return guarded;
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
    const guarded = await this.superAdminGuard(accountId, actor);
    if (guarded !== null) return guarded;
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
   * The evaluation stages this account may decide (migration 057) — as
   * assigned, so a super admin's reads as whatever was assigned to it; the
   * enforcement point (`evaluationStagesOf`) is what treats that role as all.
   */
  async stagesFor(accountId: string): Promise<readonly EvaluationStage[]> {
    const { rows } = await this.db.query<{ stage: string }>(
      'select stage from staff_evaluation_stages where account_id = $1', [accountId]);
    const held = new Set(rows.map((row) => row.stage));
    return EVALUATION_STAGES.filter((stage) => held.has(stage));
  }

  /**
   * Replace the stages, recording both sides. An empty list is allowed, unlike
   * the forms: most officers decide no evaluation stage at all, and an
   * evaluator between assignments is a normal state, not a broken account.
   */
  async setStages(
    accountId: string, stages: readonly string[], actor: Actor,
  ): Promise<Outcome> {
    const guarded = await this.superAdminGuard(accountId, actor);
    if (guarded !== null) return guarded;
    const unknown = stages.filter((stage) => !isEvaluationStage(stage));
    if (unknown.length > 0) {
      return {
        ok: false, reason: 'unknown-stage',
        detail: `Not evaluation stages: ${unknown.join(', ')}. The stages are ${EVALUATION_STAGES.join(', ')}.`,
      };
    }
    const wanted = EVALUATION_STAGES.filter((stage) => stages.includes(stage));
    const previous = await this.stagesFor(accountId);
    if (previous.length === wanted.length && previous.every((stage) => wanted.includes(stage))) {
      return { ok: true };
    }

    await this.db.transaction(async (tx) => {
      await tx.query('delete from staff_evaluation_stages where account_id = $1', [accountId]);
      for (const stage of wanted) {
        await tx.query(
          'insert into staff_evaluation_stages (account_id, stage, granted_by) values ($1,$2,$3)',
          [accountId, stage, actor.accountId]);
      }
      await this.audit.append({
        action: SECURITY_ACTIONS.accessStagesChanged,
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        beforeState: { stages: previous },
        afterState: { stages: wanted },
      }, tx);
    });

    return { ok: true };
  }

  /**
   * A super admin's access is changed only by a super admin — a view-only level
   * would take `staff:administer` away from the one role that could restore it.
   * See `super-admin-guard.ts`.
   */
  private async superAdminGuard(accountId: string, actor: Actor): Promise<Refusal | null> {
    if (!(await holdsSuperAdmin(this.db, accountId))) return null;
    if (await holdsSuperAdmin(this.db, actor.accountId)) return null;
    return { ok: false, reason: 'not-permitted', detail: SUPER_ADMIN_ONLY };
  }

  // `mayLoseSuperAdmin` lived here and was removed: StaffDirectoryService asks
  // the same question in `survivesWithout`, on the paths that can actually
  // remove the role, and two implementations of one rule is the drift the rule
  // exists to prevent. The domain function they both call is
  // `mayRemoveSuperAdmin` in domain/super-admin-floor.ts.
}
