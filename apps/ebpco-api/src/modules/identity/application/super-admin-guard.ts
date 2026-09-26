import { SqlClient } from '../../../persistence/sql-client';

/**
 * ── ONLY A SUPER ADMIN ACTS ON A SUPER ADMIN ────────────────────────────
 *
 * `staff:administer` is held by the administrator as well as the super admin,
 * and on its own it reaches every staff account. Without this rule an
 * administrator could create a second account holding `super-admin`, promote a
 * colleague to it, or set a super admin's level to view-only — which takes
 * away `staff:administer` from the one role that could undo it. That is the
 * escalation the owner closed for access requests (only the super admin
 * approves them), left open one screen over (officer positions, 2026-09-26).
 *
 * So granting or removing the role, and changing, disabling, enabling or
 * re-issuing the factor of an account that holds it, are the super admin's
 * alone. Everything else on the staff screens stays with `staff:administer`.
 */
export async function holdsSuperAdmin(db: SqlClient, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ held: boolean }>(
    `select exists (
       select 1 from account_roles where account_id = $1 and role = 'super-admin'
     ) as held`,
    [accountId],
  );
  return rows[0]?.held === true;
}

export const SUPER_ADMIN_ONLY =
  'Only a super admin can change a super admin account or grant the super admin role.';
