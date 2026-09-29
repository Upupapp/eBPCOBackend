import { SqlClient } from '../../../persistence/sql-client';
import { ROLE_SCOPES, Scope, StaffRole } from '../../identity/domain/account';
import { EvaluationStage, isEvaluationStage } from '../domain/evaluation-stages';
import { LifecycleStatus } from '../domain/lifecycle';
import { TeamKey, teamForStep } from '../domain/teams';

/**
 * Who an application is waiting on — "Assigned to" (owner request,
 * 2026-09-26: the officer accounts should be reflected throughout the system,
 * "this officer is assigned to this task").
 *
 * Derived, never stored. Each step of the lifecycle is one office's by rule
 * (the scope its transition requires, and for an evaluation the stage), and
 * the officers are whoever holds that office for this permit type today. A
 * stored assignment would be a second answer to "whose is this", free to
 * disagree with who the server actually lets act.
 */
export interface Responsibility {
  /** What happens next, in the office's words. */
  readonly step: string;
  /** The position that does it — or 'Applicant' when the citizen must act, null once closed. */
  readonly holder: string | null;
  /** The evaluation stage, when the step is one. */
  readonly stage: EvaluationStage | null;
  readonly awaitingApplicant: boolean;
  /**
   * The officers who hold this step for this permit type. Never super admins:
   * they hold every step, and listing them under every task says nothing.
   * Empty means nobody is assigned yet — only a super admin can act.
   */
  readonly officers: ReadonlyArray<{ readonly id: string; readonly name: string; readonly lead: boolean }>;
  /** The team whose step this is (migration 062), or null when no team owns it. */
  readonly team: TeamKey | null;
  /**
   * The officer the team has it with: assigned by the team lead, or taken by
   * the member who first worked on it. Null means unassigned -- any member of
   * the team may take it.
   */
  readonly assignee: { readonly id: string; readonly name: string } | null;
}

/** An application's assignments, by team, as the queue reads them. */
export type Assignments = Readonly<Partial<Record<string, { readonly id: string; readonly name: string }>>>;

/** A select-list column reading `a`'s assignments as `Assignments` (migration 062). */
export const ASSIGNMENTS_COLUMN = `(
    select jsonb_object_agg(x.team, jsonb_build_object(
             'id', x.assigned_to, 'name', coalesce(nullif(trim(xa.full_name), ''), xa.email)))
      from application_assignments x join accounts xa on xa.id = x.assigned_to
     where x.application_id = a.id) as assignments`;

export interface Step {
  readonly step: string;
  readonly scope: Scope | null;
  readonly stage: EvaluationStage | null;
  readonly awaitingApplicant: boolean;
}

/** The position that holds a scope — or, for an evaluation, the stage's office. */
export const POSITION_FOR_SCOPE: Partial<Record<Scope, string>> = {
  'staff:receive': 'Receiving Officer',
  'staff:assess': 'Assessor',
  'staff:verify-payment': 'Cashier',
  'staff:approve': 'Building Official',
  'staff:release': 'Releasing Officer',
};

export const POSITION_FOR_STAGE: Readonly<Record<EvaluationStage, string>> = {
  Initial: 'Initial Evaluator',
  Zoning: 'Zoning Officer',
  'Fire Safety': 'Fire Safety Evaluator',
  OBO: 'Technical Evaluator',
  'Final Approval': 'Building Official',
};

const officerStep = (step: string, scope: Scope, stage: EvaluationStage | null = null): Step =>
  ({ step, scope, stage, awaitingApplicant: false });
const applicantStep = (step: string): Step => ({ step, scope: null, stage: null, awaitingApplicant: true });
const CLOSED: Step = { step: 'Closed', scope: null, stage: null, awaitingApplicant: false };

/** The step an application at `status` is waiting on. `nextStage` is the first evaluation stage not yet passed. */
export function stepFor(status: LifecycleStatus, nextStage: EvaluationStage | null): Step {
  switch (status) {
    case 'Draft': return applicantStep('Applicant is completing the application');
    case 'Submitted': return officerStep('Receive the application', 'staff:receive');
    case 'Received': return officerStep('Start the document check', 'staff:receive');
    case 'Document Verification':
      return officerStep('Check the documents and start the evaluation', 'staff:evaluate', 'Initial');
    case 'Under Evaluation':
      return nextStage === null
        ? officerStep('Issue the Order of Payment', 'staff:assess')
        : officerStep(`Decide the ${nextStage} evaluation`, 'staff:evaluate', nextStage);
    case 'Revision Required': return applicantStep('Applicant is revising the application');
    case 'Assessed': return applicantStep('Applicant is paying the Order of Payment');
    case 'Payment Submitted': return officerStep('Verify the payment', 'staff:verify-payment');
    case 'Payment Under Verification': return officerStep('Finish verifying the payment', 'staff:verify-payment');
    case 'Payment Verified': return officerStep('Send the application for final approval', 'staff:verify-payment');
    case 'For Approval': return officerStep('Approve or return the application', 'staff:approve');
    case 'Approved': return officerStep('Generate the permit', 'staff:approve');
    case 'Permit Generated': return officerStep('Prepare the release', 'staff:release');
    case 'Ready for Release': return officerStep('Release the permit to the applicant', 'staff:release');
    case 'Released': return officerStep('Close the application', 'staff:release');
    default: return CLOSED;
  }
}

/** One enabled, acting staff account, as `rosterOf` reads it. */
export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly StaffRole[];
  readonly permitTypes: readonly string[];
  readonly stages: readonly EvaluationStage[];
  /** Whether this officer leads their team (migration 062). */
  readonly lead: boolean;
}

/**
 * Every staff account that can act today: enabled, not removed, and at the
 * view-edit level (a view-only officer holds no step). Read once per request
 * and matched against each application in memory — a small table, and one
 * query rather than one per row.
 */
export async function rosterOf(db: SqlClient): Promise<readonly RosterEntry[]> {
  const { rows } = await db.query<{
    id: string; name: string; roles: string[] | null; permit_types: string[] | null; stages: string[] | null;
    team_role: string;
  }>(
    `select a.id, coalesce(nullif(trim(a.full_name), ''), a.email) as name, sa.team_role,
            array(select r.role from account_roles r where r.account_id = a.id) as roles,
            array(select p.permit_type from staff_permit_access p where p.account_id = a.id) as permit_types,
            array(select s.stage from staff_evaluation_stages s where s.account_id = a.id) as stages
       from accounts a
       join staff_access sa on sa.account_id = a.id and sa.level = 'view-edit'
      where a.kind = 'staff' and a.disabled_at is null and a.removed_at is null
      order by name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    roles: (row.roles ?? []) as StaffRole[],
    permitTypes: row.permit_types ?? [],
    stages: (row.stages ?? []).filter(isEvaluationStage),
    lead: row.team_role === 'lead',
  }));
}

/** Who an application at `status`, of `permitType`, is waiting on. */
export function responsibilityFor(
  status: LifecycleStatus,
  nextStage: EvaluationStage | null,
  permitType: string,
  roster: readonly RosterEntry[],
  assignments: Assignments = {},
): Responsibility {
  const step = stepFor(status, nextStage);
  if (step.awaitingApplicant) {
    return {
      step: step.step, holder: 'Applicant', stage: null, awaitingApplicant: true, officers: [], team: null, assignee: null,
    };
  }
  if (step.scope === null) {
    return {
      step: step.step, holder: null, stage: null, awaitingApplicant: false, officers: [], team: null, assignee: null,
    };
  }
  const team = teamForStep(step.scope, step.stage);
  const scope = step.scope;
  const officers = roster
    .filter((officer) => officer.roles.some((role) => role !== 'super-admin' && ROLE_SCOPES[role].includes(scope)))
    .filter((officer) => officer.permitTypes.includes(permitType))
    .filter((officer) => step.stage === null || officer.stages.includes(step.stage))
    .map((officer) => ({ id: officer.id, name: officer.name, lead: officer.lead }))
    // The lead first: "who is this with" reads from the top of the team down.
    .sort((a, b) => Number(b.lead) - Number(a.lead));
  return {
    step: step.step,
    holder: step.stage === null ? POSITION_FOR_SCOPE[scope] ?? null : POSITION_FOR_STAGE[step.stage],
    stage: step.stage,
    awaitingApplicant: false,
    officers,
    team,
    assignee: team === null ? null : assignments[team] ?? null,
  };
}
