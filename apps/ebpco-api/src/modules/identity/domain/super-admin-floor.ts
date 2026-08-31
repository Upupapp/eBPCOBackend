/**
 * The last super admin cannot be removed.
 *
 * Every other refusal in this service protects a record. This one protects the
 * ability to administer the service at all: demote, disable or erase the final
 * enabled super admin and there is no longer anyone who can grant the role
 * back. It is the single failure that cannot be repaired from inside the
 * product — recovery means someone with database credentials, at which point
 * the access control this file belongs to has stopped being the mechanism.
 *
 * Counted over ENABLED accounts, not over rows: a disabled super admin cannot
 * sign in, so it cannot be the one that saves you.
 */
export interface SuperAdminFloor {
  /** Enabled accounts currently holding 'super-admin'. */
  readonly enabledSuperAdmins: readonly string[];
}

export type FloorRefusal = { readonly ok: false; readonly reason: string };
export type FloorDecision = { readonly ok: true } | FloorRefusal;

const REFUSAL =
  'This is the only enabled super admin. Removing it would leave nobody able to '
  + 'grant the role back, and no way to recover without database access. Appoint '
  + 'another super admin first.';

/**
 * Whether an act that would remove `accountId`'s super-admin standing is safe.
 *
 * Deliberately answers the same way for demotion, disabling and erasure. They
 * differ in every other respect and are identical in the only one that matters
 * here: afterwards, that account can no longer administer.
 */
export function mayRemoveSuperAdmin(
  floor: SuperAdminFloor, accountId: string,
): FloorDecision {
  // Not a super admin, or not an enabled one: removing it changes nothing about
  // who can administer.
  if (!floor.enabledSuperAdmins.includes(accountId)) return { ok: true };

  return floor.enabledSuperAdmins.length > 1
    ? { ok: true }
    : { ok: false, reason: REFUSAL };
}
