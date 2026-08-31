import { ROLE_SCOPES, Scope, StaffRole, grantsAuthority } from './account';

/**
 * What a staff account may work on, and how far it may go.
 *
 * Two independent questions, answered separately on purpose:
 *
 *   LEVEL  — may this person only look, or may they act?
 *   FORMS  — which permit types are theirs to look at or act on?
 *
 * Neither is a scope. Scopes stay global and coarse, exactly as `account.ts`
 * argues: a scope says what KIND of operation may be attempted, and whether it
 * may be attempted on THIS application is a domain question. Both answers here
 * are domain questions, and putting them in the token would mint seventeen
 * scopes per level and rebuild every session on a permissions change.
 */
export type AccessLevel = 'view' | 'view-edit';

export const ACCESS_LEVELS: readonly AccessLevel[] = ['view', 'view-edit'];

/**
 * The scopes a level yields, DERIVED from `grantsAuthority()`.
 *
 * Not a hand-written bundle. `grantsAuthority` already splits sight from
 * authority — it is the function that, once written, exposed an auditor able to
 * move applications through intake — and a second hand-maintained list of
 * "which scopes are the writing ones" is a list that drifts from it silently.
 *
 *   view       every scope the role holds that grants only SIGHT
 *   view-edit  everything the role holds
 *
 * So a level NARROWS a role and never widens it. An evaluator at `view-edit`
 * gets an evaluator's scopes; it does not acquire a cashier's. Separation of
 * duty survives the level system entirely, which is the property that would be
 * easiest to lose here.
 */
export function scopesAt(role: StaffRole, level: AccessLevel): readonly Scope[] {
  const held = ROLE_SCOPES[role];
  return level === 'view-edit' ? held : held.filter((scope) => !grantsAuthority(scope));
}

/**
 * The scopes a whole set of roles yields at a level.
 *
 * Union, because an account holding two roles holds both their scopes — the
 * role table is where a second role is granted visibly and auditably, and that
 * remains true at every level.
 */
export function scopesForRolesAt(
  roles: readonly StaffRole[], level: AccessLevel,
): readonly Scope[] {
  const granted = new Set<Scope>();
  for (const role of roles) for (const scope of scopesAt(role, level)) granted.add(scope);
  return [...granted];
}

/**
 * A caller's access to permit types, as the domain layer sees it.
 *
 * `permitTypes` is an allow-list of INTERNAL keys. Empty means no access, never
 * "all" — the failure that would otherwise turn a missing assignment into a
 * silent grant of everything.
 */
export interface StaffAccess {
  readonly level: AccessLevel;
  readonly permitTypes: readonly string[];
}

/** An account with no assignment. Named, so "fails closed" is a value not a gap. */
export const NO_ACCESS: StaffAccess = { level: 'view', permitTypes: [] };

export function mayWorkOn(access: StaffAccess, permitType: string): boolean {
  return access.permitTypes.includes(permitType);
}

/**
 * Whether this access permits ACTING at all, as opposed to looking.
 *
 * Asked separately from the scope check rather than folded into it, because the
 * two refusals mean different things to an officer: 'your role cannot do this'
 * and 'your access level is view-only' send them to different people.
 */
export function mayAct(access: StaffAccess): boolean {
  return access.level === 'view-edit';
}
