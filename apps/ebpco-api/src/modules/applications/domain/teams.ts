import { EvaluationStage } from './evaluation-stages';

/**
 * The teams of the permit office (owner request, 2026-09-29: "a full hierarchy
 * ... a team lead and team members").
 *
 * A team is an office: everyone holding one position. Membership is never
 * stored -- it is read from the account's roles and evaluation stages, the same
 * facts the server already authorises on -- and who LEADS is `team_role` on the
 * officer's access row (migration 062). Nine teams own a step of the lifecycle
 * and can have applications assigned; three (Records, Audit, Administration)
 * own none and are teams for the hierarchy only.
 */
export type TeamKey =
  | 'receiving' | 'initial-evaluation' | 'zoning' | 'fire-safety' | 'technical'
  | 'assessment' | 'cashier' | 'building-official' | 'releasing'
  | 'records' | 'audit' | 'administration';

export interface Team {
  readonly key: TeamKey;
  /** The team, as the office says it. */
  readonly name: string;
  /** The position its members hold. */
  readonly position: string;
  /** Whether applications wait on this team -- and so can be assigned within it. */
  readonly ownsStep: boolean;
}

export const TEAMS: readonly Team[] = [
  { key: 'receiving', name: 'Receiving', position: 'Receiving Officer', ownsStep: true },
  { key: 'initial-evaluation', name: 'Initial Evaluation', position: 'Initial Evaluator', ownsStep: true },
  { key: 'zoning', name: 'Zoning', position: 'Zoning Officer', ownsStep: true },
  { key: 'fire-safety', name: 'Fire Safety', position: 'Fire Safety Evaluator', ownsStep: true },
  { key: 'technical', name: 'Technical Evaluation (OBO)', position: 'Technical Evaluator', ownsStep: true },
  { key: 'assessment', name: 'Assessment', position: 'Assessor', ownsStep: true },
  { key: 'cashier', name: 'Cashier', position: 'Cashier', ownsStep: true },
  { key: 'building-official', name: 'Building Official', position: 'Building Official', ownsStep: true },
  { key: 'releasing', name: 'Releasing', position: 'Releasing Officer', ownsStep: true },
  { key: 'records', name: 'Records', position: 'Records Officer', ownsStep: false },
  { key: 'audit', name: 'Audit', position: 'Auditor', ownsStep: false },
  { key: 'administration', name: 'Administration', position: 'Administrator', ownsStep: false },
];

export const STEP_TEAMS: readonly TeamKey[] = TEAMS.filter((team) => team.ownsStep).map((team) => team.key);

export function teamByKey(key: string): Team | null {
  return TEAMS.find((team) => team.key === key) ?? null;
}

const STAGE_TEAM: Readonly<Record<EvaluationStage, TeamKey>> = {
  Initial: 'initial-evaluation',
  Zoning: 'zoning',
  'Fire Safety': 'fire-safety',
  OBO: 'technical',
  'Final Approval': 'building-official',
};

const SCOPE_TEAM: Readonly<Record<string, TeamKey>> = {
  'staff:receive': 'receiving',
  'staff:assess': 'assessment',
  'staff:verify-payment': 'cashier',
  'staff:approve': 'building-official',
  'staff:release': 'releasing',
};

const ROLE_TEAM: Readonly<Record<string, TeamKey>> = {
  'receiving-officer': 'receiving',
  'records-officer': 'records',
  assessor: 'assessment',
  cashier: 'cashier',
  'building-official': 'building-official',
  'releasing-officer': 'releasing',
  auditor: 'audit',
  administrator: 'administration',
};

/**
 * The team a lifecycle step belongs to: the stage's office for an evaluation,
 * otherwise the office holding the step's scope. Null for a step no team owns
 * (the applicant's, or a closed application).
 */
export function teamForStep(scope: string | null, stage: EvaluationStage | null): TeamKey | null {
  if (stage !== null) return STAGE_TEAM[stage];
  if (scope === null) return null;
  return SCOPE_TEAM[scope] ?? null;
}

/**
 * The teams an account belongs to, from its roles and stages. An evaluator is
 * in the team of each stage they decide. A super admin is in no team: they
 * stand above all of them.
 */
export function teamsOf(roles: readonly string[], stages: readonly string[]): readonly TeamKey[] {
  const teams = new Set<TeamKey>();
  for (const role of roles) {
    const team = ROLE_TEAM[role];
    if (team !== undefined) teams.add(team);
  }
  if (roles.includes('evaluator')) {
    for (const stage of stages) {
      const team = STAGE_TEAM[stage as EvaluationStage];
      if (team !== undefined) teams.add(team);
    }
  }
  return TEAMS.map((team) => team.key).filter((key) => teams.has(key));
}

/**
 * The capacity someone acted in, as the System Logs and a timeline print it
 * beside their name (QA finding TC-02, 2026-10-03): "Applicant", "Super
 * Admin", or the positions of the teams an officer belongs to ("Cashier",
 * "Initial Evaluator, Zoning Officer"). Null for no account (a system act) or
 * a staff account with no team yet.
 */
export function positionOf(
  kind: string | null, roles: readonly string[], stages: readonly string[],
): string | null {
  if (kind === null) return null;
  if (kind === 'applicant') return 'Applicant';
  if (roles.includes('super-admin')) return 'Super Admin';
  const positions = teamsOf(roles, stages).map((key) => teamByKey(key)?.position).filter((p): p is string => !!p);
  return positions.length > 0 ? positions.join(', ') : null;
}
