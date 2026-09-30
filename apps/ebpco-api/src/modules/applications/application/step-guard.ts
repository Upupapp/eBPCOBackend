import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { EvaluationStage, isEvaluationStage, stagesForChecklist } from '../domain/evaluation-stages';
import { LifecycleStatus } from '../domain/lifecycle';
import { STEP_TEAMS, TeamKey, teamByKey, teamForStep, teamsOf } from '../domain/teams';
import { Step, stepFor } from './responsibility';

/**
 * Whether an officer may WORK on an application right now (owner request,
 * 2026-09-29): "although it can see all the applications ... they can just
 * edit it if the application is on the stage where it is in [their]
 * evaluation, and it has the power to move the application to the next stage".
 *
 * Reading is not decided here -- every officer reads every application. This
 * decides working on one: editing its particulars, reviewing its documents,
 * deciding its stage, moving it on. The rule:
 *
 *   - It must be at a step of the officer's team. (A Zoning Officer holds
 *     `staff:evaluate` like an Initial Evaluator does, so the scope alone let
 *     them move an application still at the Initial step.)
 *   - Once assigned within the team, only the assignee or the team lead works
 *     on it. Unassigned, it goes to the first member who works on it.
 *   - A super admin stands above every team. A Records Officer keeps the
 *     record-keeping they already had (editing a record, withdrawing or
 *     expiring it) at any step, and is not assigned work by it.
 *
 * The existing checks stay the judges of WHAT may be done (the transition
 * table, the stage an evaluator decides, the permit types they may reach);
 * this adds WHEN and WHOSE.
 */

export type WorkKind =
  /** Changing the record itself: particulars, document verdicts. */
  | 'edit'
  /** Acting on it: a transition, a stage decision, an assessment, a permit, a release. */
  | 'act';

export type StepCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'view-only' | 'not-your-stage' | 'assigned-to-other';
      readonly detail: string;
    };

/** One officer, as the guard needs them. */
export interface Officer {
  readonly id: string;
  readonly name: string;
  readonly superAdmin: boolean;
  readonly roles: readonly string[];
  readonly teams: readonly TeamKey[];
  readonly lead: boolean;
  /** 'view-edit' officers may work; a view-only one only reads. */
  readonly canWork: boolean;
}

/** Where an application stands: its step, and the team that owns it. */
export interface Placement {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: LifecycleStatus;
  readonly nextStage: EvaluationStage | null;
  readonly step: Step;
  readonly team: TeamKey | null;
}

export async function officerOf(db: SqlClient, accountId: string): Promise<Officer | null> {
  const { rows } = await db.query<{
    id: string; name: string; roles: string[] | null; stages: string[] | null;
    level: string | null; team_role: string | null;
  }>(
    `select a.id, coalesce(nullif(trim(a.full_name), ''), a.email) as name,
            array(select r.role from account_roles r where r.account_id = a.id) as roles,
            array(select s.stage from staff_evaluation_stages s where s.account_id = a.id) as stages,
            sa.level, sa.team_role
       from accounts a
       left join staff_access sa on sa.account_id = a.id
      where a.id = $1 and a.kind = 'staff' and a.disabled_at is null and a.removed_at is null`,
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const roles = row.roles ?? [];
  return {
    id: row.id,
    name: row.name,
    superAdmin: roles.includes('super-admin'),
    roles,
    teams: teamsOf(roles, row.stages ?? []),
    lead: row.team_role === 'lead',
    canWork: row.level === 'view-edit' || roles.includes('super-admin'),
  };
}

export async function placementOf(db: SqlClient, applicationId: string): Promise<Placement | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(applicationId)) return null;
  const { rows } = await db.query<{
    id: string; reference_number: string; lifecycle_status: LifecycleStatus;
    required_documents: unknown; passed: string[] | null;
  }>(
    `select a.id, a.reference_number, a.lifecycle_status, a.required_documents,
            array(select e.stage from evaluations e where e.application_id = a.id and e.result = 'Passed') as passed
       from applications a where a.id = $1`,
    [applicationId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const passed = new Set((row.passed ?? []).filter(isEvaluationStage));
  const nextStage = stagesForChecklist(row.required_documents).find((stage) => !passed.has(stage)) ?? null;
  const step = stepFor(row.lifecycle_status, nextStage);
  return {
    id: row.id,
    referenceNumber: row.reference_number,
    status: row.lifecycle_status,
    nextStage,
    step,
    team: teamForStep(step.scope, step.stage),
  };
}

export interface Assignee {
  readonly id: string;
  readonly name: string;
}

export async function assigneeOf(db: SqlClient, applicationId: string, team: TeamKey): Promise<Assignee | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `select ac.id, coalesce(nullif(trim(ac.full_name), ''), ac.email) as name
       from application_assignments x join accounts ac on ac.id = x.assigned_to
      where x.application_id = $1 and x.team = $2`,
    [applicationId, team],
  );
  return rows[0] ?? null;
}

/**
 * Whether this officer can work on NO application, at any step: their access
 * is view-only, or no team they are in owns a step (an auditor, an
 * administrator, an evaluator with no stage). Asked before the application is
 * looked up, so such an officer is told "not permitted" rather than learning
 * from a 404 whether an id exists -- and so the answer is the same for every
 * id, which is what makes it checkable at all. A super admin stands above the
 * teams, and a Records Officer keeps record-keeping at any step.
 */
export function neverWorks(officer: Officer, keepsRecords: boolean): boolean {
  if (officer.superAdmin || keepsRecords) return false;
  return !officer.canWork || !officer.teams.some((team) => STEP_TEAMS.includes(team));
}

/** Why `neverWorks` said so, in the officer's terms. */
export function neverWorksDetail(officer: Officer): string {
  return officer.canWork
    ? 'Your position does not work on any step of an application. You can open every application, but not change or move one.'
    : 'Your access is view only. You can open every application, but not change or move one.';
}

/** The team a step is, in words: "the Zoning team". */
export function teamPhrase(team: TeamKey | null): string {
  const found = team === null ? null : teamByKey(team);
  return found === null ? 'another office' : `the ${found.name} team`;
}

export class StepGuard {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly audit: AuditService = new AuditService(db, clock),
  ) {}

  /**
   * Whether `caller` may work on the application now. On yes, an unassigned
   * application at their team's step becomes theirs: the first member to work
   * on it has taken it, and a second member is told whose it is.
   */
  async check(caller: Caller, applicationId: string, kind: WorkKind): Promise<StepCheck> {
    if (caller.kind !== 'staff') return { ok: true };
    const officer = await officerOf(this.db, caller.accountId);
    if (officer === null) return { ok: false, reason: 'not-found', detail: 'No such officer.' };
    if (officer.superAdmin) return { ok: true };
    const keepsRecords = caller.scopes.includes('applications:write');
    if (neverWorks(officer, keepsRecords)) return { ok: false, reason: 'view-only', detail: neverWorksDetail(officer) };

    const place = await placementOf(this.db, applicationId);
    if (place === null) return { ok: false, reason: 'not-found', detail: 'No such application.' };

    const inTeam = place.team !== null && officer.teams.includes(place.team) && officer.canWork;

    if (!inTeam) {
      // Record-keeping, at any step: the Records Officer's job, as before.
      if (keepsRecords) return { ok: true };
      // Nobody's step (the applicant's, or closed): the transition table and
      // the route's own rules decide, as before. Editing needs a step.
      if (place.team === null) {
        return kind === 'act'
          ? { ok: true }
          : {
              ok: false, reason: 'not-your-stage',
              detail: `${place.referenceNumber} is not at an office's step right now (${place.step.step.toLowerCase()}), `
                + 'so there is nothing to edit. You can still view it.',
            };
      }
      return {
        ok: false, reason: 'not-your-stage',
        detail: `${place.referenceNumber} is at the "${place.step.step}" step, which is ${teamPhrase(place.team)}'s. `
          + 'You can view it; only that team can work on it now.',
      };
    }

    const team = place.team;
    const assignee = await assigneeOf(this.db, applicationId, team);
    if (assignee !== null && assignee.id !== officer.id && !officer.lead) {
      return {
        ok: false, reason: 'assigned-to-other',
        detail: `${place.referenceNumber} is assigned to ${assignee.name}. Only they or your team lead can work on it; `
          + 'ask your team lead to reassign it if it should be yours.',
      };
    }
    if (assignee === null) await this.take(applicationId, team, officer);
    return { ok: true };
  }

  /**
   * Why `caller` may not ACCEPT this document now, or null when they may.
   *
   * A document is accepted at the stage that checks it: the Fire Safety
   * Evaluation Clearance by Fire Safety, the zoning clearance by Zoning. The
   * team at the step could otherwise accept every document, and a later stage
   * then had nothing left to check -- found in a live pass on 2026-09-30, the
   * Initial Evaluator accepted all 22 and Zoning, Fire Safety and OBO passed
   * on documents they never looked at. Sending a document back is not limited:
   * any team at the step may ask for a revision. A super admin and the Records
   * Officer (record-keeping) are not limited either.
   */
  async acceptRefusal(caller: Caller, applicationId: string, documentId: string): Promise<string | null> {
    if (caller.kind !== 'staff' || caller.scopes.includes('applications:write')) return null;
    const officer = await officerOf(this.db, caller.accountId);
    if (officer === null || officer.superAdmin) return null;
    const place = await placementOf(this.db, applicationId);
    if (place === null) return null;
    const stages = await this.db.query<{ required_documents: unknown; requirement_code: string | null; label: string }>(
      `select a.required_documents, d.requirement_code, d.label
         from documents d join applications a on a.id = d.application_id
        where d.id = $1 and d.application_id = $2`,
      [documentId, applicationId],
    );
    const row = stages.rows[0];
    if (row === undefined) return null;
    const entry = (Array.isArray(row.required_documents) ? row.required_documents : []).find(
      (e): e is { stage: string } => typeof e === 'object' && e !== null
        && typeof (e as Record<string, unknown>)['stage'] === 'string'
        && isEvaluationStage((e as Record<string, unknown>)['stage'] as string)
        && ((e as Record<string, unknown>)['code'] === row.requirement_code
          || (row.requirement_code === null && (e as Record<string, unknown>)['label'] === row.label)),
    );
    if (entry === undefined) return null;
    const current = place.status === 'Under Evaluation' ? place.nextStage
      : place.status === 'Document Verification' ? (stagesForChecklist(row.required_documents)[0] ?? null)
        : null;
    if (current === null || entry.stage === current) return null;
    return `"${row.label}" is checked at the ${entry.stage} stage, so its evaluator accepts it when ${place.referenceNumber} `
      + `gets there. You can still request a revision of it now.`;
  }

  /** The first member to work on an unassigned application has taken it. */
  private async take(applicationId: string, team: TeamKey, officer: Officer): Promise<void> {
    const inserted = await this.db.query(
      `insert into application_assignments (application_id, team, assigned_to, assigned_by, assigned_at)
       values ($1,$2,$3,$3,$4) on conflict (application_id, team) do nothing returning application_id`,
      [applicationId, team, officer.id, this.clock()],
    );
    if (inserted.rows.length === 0) return;
    await this.audit.append({
      action: 'application.assigned',
      subjectType: 'application',
      subjectId: applicationId,
      outcome: 'allowed',
      actorAccountId: officer.id,
      actorRole: 'staff',
      afterState: { team, assignedTo: officer.id, how: 'taken by working on it' },
    });
  }
}
