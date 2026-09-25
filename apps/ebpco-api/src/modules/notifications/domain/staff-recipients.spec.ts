import { LIFECYCLE_STATUSES, TRANSITIONS, TransitionRule } from '../../applications/domain/lifecycle';
import { recipientsFor } from './staff-recipients';

/**
 * The routing table, written down.
 *
 * D-7 chose routing BY ROLE FROM THE TRANSITION RULE, which means the fan-out
 * is a consequence of the workflow rather than a list anyone maintains. That is
 * the point — and it is also why it has to be asserted: a rule derived from
 * data is only as good as what the data currently says, and nothing else in the
 * codebase would notice if a scope change quietly redirected every payment
 * notice to the building official.
 *
 * So the whole table is here, every status, including the ones that notify
 * NOBODY. Those are the load-bearing rows: a notice sent to an officer about an
 * application that is waiting on the APPLICANT is an invitation to cancel
 * someone who is doing exactly what was asked.
 */

const EXPECTED: Readonly<Record<string, { reason: string; roles: string[] }>> = {
  // Was `awaiting-applicant`/[] until the walk-in-intake draft feature added
  // 'staff' to Draft -> Submitted's actors (an officer-started draft must be
  // resumable and finishable by any officer, not just the one who began it).
  // Unreachable today -- nothing writes a Draft row yet (Save-as-draft is
  // still a plan, not shipped) -- but this is a pure function tested for
  // every status regardless of reachability, and the answer is now correct
  // for the case it will matter for: a colleague finishing a walk-in draft.
  'Draft': { reason: 'oversight-only', roles: ['records-officer', 'super-admin'] },
  // Was `evaluator` until 2026-08-30, because intake was gated on
  // `applications:read` and the evaluator was the narrowest holder. With
  // `staff:receive` the notice reaches the officer whose job the status names.
  'Submitted': { reason: 'expected-move', roles: ['receiving-officer'] },
  'Received': { reason: 'expected-move', roles: ['receiving-officer'] },
  'Document Verification': { reason: 'expected-move', roles: ['evaluator'] },
  'Under Evaluation': { reason: 'expected-move', roles: ['assessor'] },
  // The applicant is revising. The only staff move out is Expire, and telling
  // an officer this queue is theirs would put a deadline in front of someone
  // whose job at this moment is to wait.
  'Revision Required': { reason: 'awaiting-applicant', roles: [] },
  // The applicant is PAYING. Same shape: the staff moves are Cancel and Expire.
  'Assessed': { reason: 'awaiting-applicant', roles: [] },
  'Payment Submitted': { reason: 'expected-move', roles: ['cashier'] },
  'Payment Under Verification': { reason: 'expected-move', roles: ['cashier'] },
  'Payment Verified': { reason: 'expected-move', roles: ['cashier'] },
  // Oversight-only: every holder of staff:approve (building-official, and
  // since the owner's 2026-09-13 reversal super-admin too — see
  // SUPER_ADMIN_SCOPES's own doc comment) sees every status by design, so
  // the "not a queue" exclusion would otherwise leave nobody.
  'For Approval': { reason: 'oversight-only', roles: ['building-official', 'super-admin'] },
  'Approved': { reason: 'oversight-only', roles: ['building-official', 'super-admin'] },
  'Permit Generated': { reason: 'expected-move', roles: ['releasing-officer'] },
  'Ready for Release': { reason: 'expected-move', roles: ['releasing-officer'] },
  'Released': { reason: 'expected-move', roles: ['releasing-officer'] },
  'Completed': { reason: 'terminal', roles: [] },
  'Rejected': { reason: 'terminal', roles: [] },
  'Cancelled': { reason: 'terminal', roles: [] },
  'Expired': { reason: 'terminal', roles: [] },
};

describe('who is told an application is waiting', () => {
  it('routes every status exactly as written down', () => {
    const actual = Object.fromEntries(LIFECYCLE_STATUSES.map((status) => {
      const decision = recipientsFor(status, TRANSITIONS);
      return [status, { reason: decision.reason, roles: [...decision.roles].sort() }];
    }));

    expect(actual).toEqual(EXPECTED);
  });

  it('never fans a single status out to more than two roles', () => {
    // An inbox that fills is one nobody reads. This is the number the D-7
    // conversation turned on, so it is asserted rather than remembered.
    for (const status of LIFECYCLE_STATUSES) {
      expect(recipientsFor(status, TRANSITIONS).roles.length).toBeLessThanOrEqual(2);
    }
  });

  it('tells nobody when the applicant is the one who must act', () => {
    // Proved from the rules rather than the list above, so the two cannot agree
    // with each other while both being wrong.
    for (const status of LIFECYCLE_STATUSES) {
      const first = TRANSITIONS.find((rule) => rule.from === status);
      if (first === undefined || first.actors.includes('staff')) continue;
      expect(recipientsFor(status, TRANSITIONS).roles).toEqual([]);
    }
  });
});

describe('the routing follows the rules it is given, not the compiled ones', () => {
  // The whole argument for D-7's answer was that editing the workflow edits the
  // routing in the same act. If this can be broken by passing different rules,
  // it is a hard-coded table wearing a parameter.
  const rewire = (requires: TransitionRule['requires']): readonly TransitionRule[] => [
    { from: 'Submitted', to: 'Received', actors: ['staff'], requires, preconditions: [] },
    ...TRANSITIONS.filter((rule) => !(rule.from === 'Submitted' && rule.to === 'Received')),
  ];

  it('sends the notice wherever the edited rule points', () => {
    expect(recipientsFor('Submitted', TRANSITIONS).roles).toEqual(['receiving-officer']);
    // Same status, same code, different rule: the cashier holds
    // staff:verify-payment but cannot SEE 'Submitted' (its visibility starts
    // later, at payment stages), so it is filtered by `canSee` same as
    // before. What changed since the owner's 2026-09-13 reversal is that
    // super-admin now holds every acting scope, including this one, AND sees
    // every status by design — so where this used to reach nobody, it now
    // falls back to the oversight role rather than staying silent.
    const viaCashierScope = recipientsFor('Submitted', rewire('staff:verify-payment'));
    expect(viaCashierScope.reason).toBe('oversight-only');
    expect(viaCashierScope.roles).toEqual(['super-admin']);
    expect([...recipientsFor('Submitted', rewire('applications:write')).roles].sort())
      .toEqual(['records-officer', 'super-admin']);
  });

  it('tells NOBODY when the scope is not one any staff role holds at all', () => {
    // A hazard D-5 created and this rule inherits. An administrator may point
    // a move at any scope the system has; if no staff role holds it, the
    // move is legal and no officer is ever told — an application waiting in
    // a queue nobody can even reach.
    //
    // Not `staff:release` any more: since the owner's 2026-09-13 reversal,
    // super-admin holds every ACTING scope (including that one) and sees
    // every status, so an acting scope routed anywhere now always reaches at
    // least super-admin — this genuinely-nobody case only survives for a
    // scope no staff role, super-admin included, has ever needed:
    // `payments:write` exists for APPLICANT tokens only (see
    // SUPER_ADMIN_SCOPES's own doc comment on why it was deliberately left
    // out of the union).
    const decision = recipientsFor('Submitted', rewire('payments:write'));

    expect(decision.roles).toEqual([]);
    // The reason is the whole value: an empty list alone cannot tell "nobody
    // needs to act" from "nobody CAN act", and those are opposite problems.
    expect(decision.reason).toBe('nobody-holds-it');
    expect(decision.awaiting).toEqual({ to: 'Received', requires: 'payments:write' });
  });
});

describe('the receiving officer is a real queue again', () => {
  it('is routed the two intake statuses', () => {
    // This role held two READ scopes and no acting scope, matched no visibility
    // rule, and could see no application at all -- so every notice to it was
    // correctly withheld and the role was, in practice, inert. `staff:receive`
    // made it an officer with work. Recorded here because the previous
    // assertion in this file pinned the blindness as if it were intended.
    expect(recipientsFor('Submitted', TRANSITIONS).roles).toContain('receiving-officer');
    expect(recipientsFor('Received', TRANSITIONS).roles).toContain('receiving-officer');
  });
});
