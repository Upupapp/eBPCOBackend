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

/** The stages a checklist document can be checked at — every stage but Final Approval, which checks none. */
export const CHECKLIST_STAGES = ['Initial', 'Zoning', 'Fire Safety', 'OBO'] as const;
export type ChecklistStage = (typeof CHECKLIST_STAGES)[number];

export function isChecklistStage(value: string): value is ChecklistStage {
  return (CHECKLIST_STAGES as readonly string[]).includes(value);
}

/**
 * The stages an application goes through, from the checklist it was filed
 * against (migration 060): Initial and Final Approval always; Zoning, Fire
 * Safety and OBO only when a REQUIRED document on that checklist is checked at
 * that stage. A Fencing Permit has nothing for the Bureau of Fire Protection
 * to check, so it never waits on the Fire Safety stage.
 *
 * A checklist snapshotted before 060 names no stages and keeps all five — it
 * was filed under that rule. Mirrors the SQL function
 * `application_evaluation_stages`, which the queue and the lifecycle use; the
 * two are tested against each other.
 */
export function stagesForChecklist(checklist: unknown): readonly EvaluationStage[] {
  const entries = Array.isArray(checklist)
    ? checklist.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
  if (!entries.some((entry) => 'stage' in entry)) return EVALUATION_STAGES;
  const checked = new Set(
    entries.filter((entry) => entry['required'] !== false).map((entry) => String(entry['stage'])),
  );
  return EVALUATION_STAGES.filter(
    (stage) => stage === 'Initial' || stage === 'Final Approval' || checked.has(stage),
  );
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
 * The stage an application is waiting on: the first of ITS stages (see
 * `stagesForChecklist`) not yet passed. An adverse verdict does not settle a
 * stage — see `EvaluationService`. Null once every one of them has passed.
 */
export async function nextStageOf(db: SqlClient, applicationId: string): Promise<EvaluationStage | null> {
  const { rows } = await db.query<{ required_documents: unknown; passed: string[] | null }>(
    `select a.required_documents,
            array(select e.stage from evaluations e
                   where e.application_id = a.id and e.result = 'Passed') as passed
       from applications a where a.id = $1`,
    [applicationId],
  );
  const row = rows[0];
  const passed = new Set(row?.passed ?? []);
  return stagesForChecklist(row?.required_documents).find((stage) => !passed.has(stage)) ?? null;
}

/** "You are assigned X and Y" / "You have no evaluation stage assigned", for refusals. */
export function describeHeld(held: 'all' | readonly EvaluationStage[]): string {
  if (held === 'all') return 'You may decide every stage.';
  if (held.length === 0) return 'Your account has no evaluation stage assigned.';
  return `Your account is assigned: ${held.join(', ')}.`;
}
