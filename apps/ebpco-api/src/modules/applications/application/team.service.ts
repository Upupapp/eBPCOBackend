import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { isEvaluationStage, stagesForChecklist } from '../domain/evaluation-stages';
import { LifecycleStatus } from '../domain/lifecycle';
import { TEAMS, TeamKey, teamForStep, teamsOf } from '../domain/teams';
import { stepFor } from './responsibility';
import { assigneeOf, neverWorks, neverWorksDetail, officerOf, placementOf, teamPhrase } from './step-guard';

/**
 * The teams of the permit office, their leads and members, and the work
 * waiting on each (owner request, 2026-09-29). And the one write a lead has
 * that a member does not: giving an application to a member.
 */

export interface TeamMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly lead: boolean;
  /** View-only officers are on the team but hold no work. */
  readonly canWork: boolean;
  /** Applications at this team's step assigned to this officer. */
  readonly assigned: number;
}

export interface TeamOverview {
  readonly key: TeamKey;
  readonly name: string;
  readonly position: string;
  readonly ownsStep: boolean;
  readonly members: readonly TeamMember[];
  /** Applications waiting at this team's step. */
  readonly waiting: number;
  /** Of those, assigned to nobody yet. */
  readonly unassigned: number;
}

export type AssignResult =
  | { readonly ok: true; readonly assignee: { readonly id: string; readonly name: string } | null; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'no-team' | 'not-permitted' | 'not-in-team' | 'taken';
      readonly detail: string;
    };

export class TeamService {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly audit: AuditService = new AuditService(db, clock),
  ) {}

  async overview(): Promise<readonly TeamOverview[]> {
    const staff = await this.db.query<{
      id: string; name: string; email: string; roles: string[] | null; stages: string[] | null;
      level: string | null; team_role: string | null;
    }>(
      `select a.id, coalesce(nullif(trim(a.full_name), ''), a.email) as name, a.email,
              array(select r.role from account_roles r where r.account_id = a.id) as roles,
              array(select s.stage from staff_evaluation_stages s where s.account_id = a.id) as stages,
              sa.level, sa.team_role
         from accounts a left join staff_access sa on sa.account_id = a.id
        where a.kind = 'staff' and a.disabled_at is null and a.removed_at is null
        order by name`,
    );

    // Where every live application stands: which team's step it is at.
    const live = await this.db.query<{
      id: string; lifecycle_status: LifecycleStatus; required_documents: unknown; passed: string[] | null;
    }>(
      `select a.id, a.lifecycle_status, a.required_documents,
              array(select e.stage from evaluations e where e.application_id = a.id and e.result = 'Passed') as passed
         from applications a
         join lifecycle_statuses ls on ls.status = a.lifecycle_status
        where a.archived_at is null and not ls.terminal and a.lifecycle_status <> 'Draft'`,
    );
    const atTeam = new Map<string, TeamKey>();
    for (const row of live.rows) {
      const passed = new Set((row.passed ?? []).filter(isEvaluationStage));
      const next = stagesForChecklist(row.required_documents).find((stage) => !passed.has(stage)) ?? null;
      const step = stepFor(row.lifecycle_status, next);
      const team = teamForStep(step.scope, step.stage);
      if (team !== null) atTeam.set(row.id, team);
    }
    const assignments = await this.db.query<{ application_id: string; team: TeamKey; assigned_to: string }>(
      'select application_id, team, assigned_to from application_assignments',
    );
    const current = assignments.rows.filter((row) => atTeam.get(row.application_id) === row.team);

    return TEAMS.map((team) => {
      const members = staff.rows
        .filter((row) => !(row.roles ?? []).includes('super-admin')
          && teamsOf(row.roles ?? [], row.stages ?? []).includes(team.key))
        .map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          lead: row.team_role === 'lead',
          canWork: row.level === 'view-edit',
          assigned: current.filter((a) => a.team === team.key && a.assigned_to === row.id).length,
        }))
        .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name));
      const waiting = [...atTeam.values()].filter((key) => key === team.key).length;
      const assignedHere = current.filter((a) => a.team === team.key).length;
      return {
        key: team.key, name: team.name, position: team.position, ownsStep: team.ownsStep,
        members, waiting, unassigned: Math.max(0, waiting - assignedHere),
      };
    });
  }

  /**
   * Gives an application at a team's step to one of the team, or takes it
   * back to unassigned (`assigneeId` null).
   *
   *   - The team lead (and a super admin) may give it to any member who can
   *     work, or unassign it.
   *   - A member may take an UNASSIGNED one for themselves, and hand back one
   *     that is theirs. Anything else is the lead's call.
   */
  /**
   * Why this caller can assign nothing at all, or null when they might. Asked
   * before the request is even read, so an officer who never works is refused
   * the same way whatever they send.
   */
  async refusesOutright(caller: Caller): Promise<string | null> {
    const officer = await officerOf(this.db, caller.accountId);
    return officer !== null && neverWorks(officer, false) ? neverWorksDetail(officer) : null;
  }

  async assign(options: { caller: Caller; applicationId: string; assigneeId: string | null }): Promise<AssignResult> {
    const { caller, applicationId, assigneeId } = options;
    const officer = await officerOf(this.db, caller.accountId);
    if (officer !== null && neverWorks(officer, false)) {
      return { ok: false, reason: 'not-permitted', detail: neverWorksDetail(officer) };
    }
    const place = await placementOf(this.db, applicationId);
    if (officer === null || place === null) return { ok: false, reason: 'not-found', detail: 'No such application.' };
    if (place.team === null) {
      return {
        ok: false, reason: 'no-team',
        detail: `${place.referenceNumber} is not waiting on an office right now (${place.step.step.toLowerCase()}), `
          + 'so there is nothing to assign.',
      };
    }
    const team = place.team;
    // A lead with view-only access leads nobody's work: handing it out is working on it.
    const leads = officer.superAdmin || (officer.lead && officer.canWork && officer.teams.includes(team));
    const member = officer.teams.includes(team) && officer.canWork;
    const current = await assigneeOf(this.db, applicationId, team);

    if (!leads) {
      const takingFree = member && assigneeId === officer.id && current === null;
      const handingBack = member && assigneeId === null && current?.id === officer.id;
      if (!member) {
        return {
          ok: false, reason: 'not-permitted',
          detail: `${place.referenceNumber} is at ${teamPhrase(team)}'s step; only that team works on it.`,
        };
      }
      if (!takingFree && !handingBack) {
        return {
          ok: false, reason: current !== null && current.id !== officer.id ? 'taken' : 'not-permitted',
          detail: current !== null && current.id !== officer.id
            ? `${place.referenceNumber} is already with ${current.name}. Ask your team lead to reassign it.`
            : 'Only your team lead can give an application to someone else.',
        };
      }
    }

    let assignee: { id: string; name: string } | null = null;
    if (assigneeId !== null) {
      const target = await officerOf(this.db, assigneeId);
      if (target === null || !target.teams.includes(team) || !target.canWork) {
        return {
          ok: false, reason: 'not-in-team',
          detail: `That officer is not a working member of ${teamPhrase(team)}, so they cannot take ${place.referenceNumber}.`,
        };
      }
      assignee = { id: target.id, name: target.name };
    }

    await this.db.transaction(async (tx) => {
      if (assignee === null) {
        await tx.query('delete from application_assignments where application_id = $1 and team = $2', [applicationId, team]);
      } else {
        await tx.query(
          `insert into application_assignments (application_id, team, assigned_to, assigned_by, assigned_at)
           values ($1,$2,$3,$4,$5)
           on conflict (application_id, team) do update
             set assigned_to = excluded.assigned_to, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`,
          [applicationId, team, assignee.id, officer.id, this.clock()],
        );
      }
      await this.audit.append({
        action: assignee === null ? 'application.unassigned' : 'application.assigned',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: officer.id,
        actorRole: 'staff',
        beforeState: { team, assignedTo: current?.id ?? null },
        afterState: { team, assignedTo: assignee?.id ?? null },
      }, tx);
    });

    return {
      ok: true,
      assignee,
      detail: assignee === null
        ? `${place.referenceNumber} is unassigned: anyone in ${teamPhrase(team)} can take it.`
        : assignee.id === officer.id
          ? `${place.referenceNumber} is yours now.`
          : `${place.referenceNumber} is now with ${assignee.name}.`,
    };
  }
}
