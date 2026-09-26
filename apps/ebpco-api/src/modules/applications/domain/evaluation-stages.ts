import { SqlClient } from '../../../persistence/sql-client';

/**
 * The five evaluation stages, in the order they are worked — the LGU's own
 * order (see `EvaluationService`). Lives in the domain, not beside the
 * service, because the staff directory validates stage assignments against it
 * and must not import an application service to do so.
 */
export const EVALUATION_STAGES = ['Initial', 'Zoning', 'Fire Safety', 'OBO', 'Final Approval'] as const;
export type EvaluationStage = (typeof EVALUATION_STAGES)[number];

export function isEvaluationStage(value: string): value is EvaluationStage {
  return (EVALUATION_STAGES as readonly string[]).includes(value);
}

/**
 * Which stages an officer may decide: `'all'` for a super admin, who holds
 * every scope and so every stage, otherwise exactly the stages assigned in
 * `staff_evaluation_stages` (migration 057). None assigned means none — the
 * same fail-closed reading the forms allow-list has, because an evaluator
 * reaching every stage by accident is the failure the assignment prevents.
 */
export async function evaluationStagesOf(
  db: SqlClient, accountId: string,
): Promise<'all' | readonly EvaluationStage[]> {
  const { rows } = await db.query<{ super_admin: boolean; stages: string[] | null }>(
    `select exists (select 1 from account_roles
                     where account_id = $1 and role = 'super-admin') as super_admin,
            (select array_agg(stage order by stage) from staff_evaluation_stages
              where account_id = $1) as stages`,
    [accountId],
  );
  const row = rows[0];
  if (row?.super_admin === true) return 'all';
  return (row?.stages ?? []).filter(isEvaluationStage);
}

export function holdsStage(held: 'all' | readonly EvaluationStage[], stage: EvaluationStage): boolean {
  return held === 'all' || held.includes(stage);
}

/**
 * The stage an application is waiting on: the first one not yet passed.
 * An adverse verdict does not settle a stage — see `EvaluationService`.
 * Null once every stage has passed.
 */
export async function nextStageOf(db: SqlClient, applicationId: string): Promise<EvaluationStage | null> {
  const { rows } = await db.query<{ stage: string }>(
    `select stage from evaluations where application_id = $1 and result = 'Passed'`,
    [applicationId],
  );
  const passed = new Set(rows.map((row) => row.stage));
  return EVALUATION_STAGES.find((stage) => !passed.has(stage)) ?? null;
}

/** "You are assigned X and Y" / "You have no evaluation stage assigned", for refusals. */
export function describeHeld(held: 'all' | readonly EvaluationStage[]): string {
  if (held === 'all') return 'You may decide every stage.';
  if (held.length === 0) return 'Your account has no evaluation stage assigned.';
  return `Your account is assigned: ${held.join(', ')}.`;
}
