import { ROLE_SCOPES, Scope, StaffRole } from '../../identity/domain/account';
import { LifecycleStatus, TransitionRule } from '../../applications/domain/lifecycle';
import { visibleStatusesFor } from '../../applications/domain/visibility';

/**
 * Who is told that an application is waiting.
 *
 * Owner decision D-7, 2026-08-29: **by role, taken from the transition rule.**
 * The alternatives were by assignment (no assignment model exists in any
 * migration, so it is a feature before it is a routing choice), by subscription
 * (an unsubscribed queue is a silence nobody is accountable for), and an
 * activity feed (which is what the portal renders today and cannot say "you
 * must act").
 *
 * The rule reads the lifecycle itself: a notice about an application goes to
 * the officers holding the scope its NEXT move requires. Since D-5 that is
 * editable data, so an LGU that rewires its workflow rewires its notifications
 * in the same act — there is no second table to keep in step, which is the
 * usual way this kind of routing goes stale.
 *
 * ── Two corrections the naive version needs ─────────────────────────────
 *
 * FIRST, the happy path. A status usually has several legal moves, and the
 * exceptional one ("Cancelled") is not what anyone is waiting for. The moves
 * are stored in order since D-5, so the first is the one the process expects.
 *
 * SECOND, oversight roles are not queues. `staff:administer`,
 * `applications:write` and `staff:approve` see every status by design, so
 * "notify everyone who could act" hands an administrator every event in the
 * office and destroys the inbox it was meant to create. A role that sees
 * everything is told only when nobody narrower can act — measured per status in
 * the spec, so the cost of this choice is written down rather than assumed.
 */

/** Roles whose visibility is the whole pipeline: oversight, not a worklist. */
export function seesEverything(role: StaffRole): boolean {
  return visibleStatusesFor({
    kind: 'staff', accountId: '', scopes: [...ROLE_SCOPES[role]],
  }) === 'all';
}

export interface RecipientDecision {
  readonly roles: readonly StaffRole[];
  /** The move they are being told about, for the notice's own wording. */
  readonly awaiting: { readonly to: LifecycleStatus; readonly requires: Scope } | null;
  /** Why the set is what it is — carried into the test output, not guessed at. */
  readonly reason:
    | 'expected-move'
    /** Nobody narrower than an oversight role can make the move. */
    | 'oversight-only'
    /** The next act is the applicant's. Staff are not waiting, and are not told. */
    | 'awaiting-applicant'
    | 'terminal'
    | 'nobody-holds-it';
}

/**
 * Who must decide once the APPLICANT has run out of time.
 *
 * The first STAFF move out, which is exactly the search that was wrong in
 * `recipientsFor` and is right here -- and the difference is the whole reason
 * both functions exist.
 *
 * `recipientsFor` answers "who is waiting". At `Assessed` the answer is nobody:
 * the applicant is paying, and the only staff moves are Cancel and Expire, so
 * telling an officer their queue has work would invite them to cancel someone
 * doing exactly what was asked.
 *
 * This answers a different question -- "the applicant has STOPPED, who decides
 * what happens now" -- and there Cancel and Expire are precisely the moves in
 * question. The premise has changed, so the same search gives the right answer.
 */
export function recipientsWhenApplicantStalls(
  status: LifecycleStatus,
  rules: readonly TransitionRule[],
): RecipientDecision {
  const next = rules.find((rule) => rule.from === status && rule.actors.includes('staff'));
  if (next === undefined) return { roles: [], awaiting: null, reason: 'terminal' };
  return decide(next, status);
}

export function recipientsFor(
  status: LifecycleStatus,
  rules: readonly TransitionRule[],
): RecipientDecision {
  // THE FIRST move out, and only the first. Not the first move a member of
  // staff happens to be able to make.
  //
  // The difference is not academic; the first version of this searched for a
  // staff move and got two statuses wrong. An application at `Assessed` is
  // waiting for the applicant to PAY -- the only staff moves out of it are
  // Cancel and Expire -- so searching for a staff move told the assessor an
  // application was in their queue when the correct action was to wait. Same at
  // `Revision Required`, where the applicant is revising and the staff move is
  // Expire. Both would have been standing invitations to cancel an application
  // whose applicant was doing exactly what was asked.
  const next = rules.find((rule) => rule.from === status);
  if (next === undefined) return { roles: [], awaiting: null, reason: 'terminal' };
  if (!next.actors.includes('staff')) {
    return { roles: [], awaiting: null, reason: 'awaiting-applicant' };
  }

  return decide(next, status);
}

function decide(next: TransitionRule, status: LifecycleStatus): RecipientDecision {
  const awaiting = { to: next.to, requires: next.requires };
  const holders = (Object.keys(ROLE_SCOPES) as StaffRole[])
    .filter((role) => ROLE_SCOPES[role].includes(next.requires))
    .filter((role) => canSee(role, status));

  const worklist = holders.filter((role) => !seesEverything(role));
  if (worklist.length > 0) return { roles: worklist, awaiting, reason: 'expected-move' };

  // Nobody narrow holds it. Falling back to the oversight roles is right here:
  // the alternative is an application nobody is told about, which is the exact
  // failure this whole feature exists to prevent.
  if (holders.length > 0) return { roles: holders, awaiting, reason: 'oversight-only' };

  // The move is legal and no role can make it. Reachable only by editing the
  // workflow, and worth naming rather than silently returning nobody.
  return { roles: [], awaiting, reason: 'nobody-holds-it' };
}

function canSee(role: StaffRole, status: LifecycleStatus): boolean {
  const visible = visibleStatusesFor({
    kind: 'staff', accountId: '', scopes: [...ROLE_SCOPES[role]],
  });
  return visible === 'all' || visible.includes(status);
}
