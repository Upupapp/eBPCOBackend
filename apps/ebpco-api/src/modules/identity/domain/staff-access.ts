
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
 * The level→scope derivation lives in `scopesFor` (account.ts), beside
 * `ROLE_SCOPES` and `grantsAuthority` that it is built from.
 *
 * It was briefly here as well, and two functions computing one rule is the
 * drift the rule exists to prevent — the second would have kept saying `view`
 * meant read-only long after the first stopped agreeing. One definition, at the
 * single point a staff token's scopes are decided.
 */

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
