import {
  ROLE_SCOPES, StaffRole, grantsAuthority, isReadOnlyRole,
} from '../../identity/domain/account';
import { LIFECYCLE_STATUSES, TRANSITIONS } from './lifecycle';
import { visibleStatusesFor } from './visibility';

/**
 * Every role can see something, and can see what its own moves need.
 *
 * SCOPE_VISIBILITY is keyed by SCOPE while roles are defined by sets of scopes,
 * and the gap between those two shapes is where a role silently ends up able to
 * see nothing. Its own comment warns about exactly this -- "granting that
 * breadth to a new role is a visible change here rather than an accident of an
 * omitted case" -- and the accident happened anyway, twice.
 *
 * Written as a table over the role list rather than as individual cases,
 * because an individual case is only ever written for a role somebody was
 * already thinking about, and the failure is a role nobody was.
 */

const seesNothing = (role: StaffRole): boolean => {
  const visible = visibleStatusesFor({
    kind: 'staff', accountId: '', scopes: [...ROLE_SCOPES[role]],
  });
  return visible !== 'all' && visible.length === 0;
};

const canSee = (role: StaffRole, status: string): boolean => {
  const visible = visibleStatusesFor({
    kind: 'staff', accountId: '', scopes: [...ROLE_SCOPES[role]],
  });
  return visible === 'all' || visible.includes(status as never);
};

/**
 * `administrator` holds only `staff:administer`, which grants `all` -- so it is
 * not an exception here. A role that legitimately sees no application would
 * have to be named, and none is.
 */
describe('no staff role is blind', () => {
  it.each(Object.keys(ROLE_SCOPES) as StaffRole[])(
    '%s can see at least one status', (role) => {
      expect(seesNothing(role)).toBe(false);
    },
  );
});

/**
 * Known contradictions between the transition table and the row filter, with a
 * reason each. A NEW one fails this test.
 *
 * The register exists because these two tables answer different questions and
 * can disagree without anyone noticing: the transition rules say which scope
 * may make a move, the row filter says which statuses a caller may read, and
 * when they disagree an officer is assigned work by one and shown a 404 by the
 * other, with no error naming the contradiction.
 */
const ACCEPTED_CONTRADICTIONS: Readonly<Record<string, string>> = {
  // EMPTY, and it stayed that way by fixing a rule rather than by widening a
  // filter to match it.
  //
  // It briefly held three: assessor, cashier and releasing-officer could all
  // make `Submitted -> Received`, because that move was gated on
  // `applications:read` -- a read scope held by eight of ten roles. The reading
  // at the time was "an assessor is not expected to do intake, so record it and
  // move on". That was wrong: the same looseness meant `auditor` could perform
  // the move too, and the read-everything-change-nothing role having write
  // authority is not a contradiction to accept. `staff:receive` closed it, and
  // this register emptied itself.
};

describe('a role can see the applications its own moves act on', () => {
  it('has no contradiction between the rules and the row filter beyond the recorded ones', () => {
    const found: string[] = [];

    for (const role of Object.keys(ROLE_SCOPES) as StaffRole[]) {
      const held = new Set<string>(ROLE_SCOPES[role]);
      for (const rule of TRANSITIONS) {
        if (!rule.actors.includes('staff') || !held.has(rule.requires)) continue;
        if (!canSee(role, rule.from)) found.push(`${role}: ${rule.from} -> ${rule.to}`);
      }
    }

    // Checked both ways. An entry that stops being true has to be removed, or
    // the register becomes a list of things that used to be wrong.
    expect(found.sort()).toEqual(Object.keys(ACCEPTED_CONTRADICTIONS).sort());
  });
});

describe('the auditor sees everything, which is the definition of the role', () => {
  it('can see every status', () => {
    // ROLE_SCOPES calls it "READ EVERYTHING, CHANGE NOTHING" and says the
    // absence of a write scope IS the definition of the role. A read-everything
    // role that reads nothing is the two halves of the codebase disagreeing.
    for (const status of LIFECYCLE_STATUSES) {
      expect(canSee('auditor', status)).toBe(true);
    }
  });
});

describe('no transition names a scope that confers only sight', () => {
  it('gates every staff move on a scope that grants authority', () => {
    // The seed half of the guarantee. `WorkflowConfigService` refuses the same
    // thing at runtime, and both are needed: this one cannot be edited around,
    // and that one covers a lifecycle this file never sees.
    const readGated = TRANSITIONS
      .filter((rule) => rule.actors.includes('staff'))
      .filter((rule) => !grantsAuthority(rule.requires))
      .map((rule) => `${rule.from} -> ${rule.to} requires ${rule.requires}`);

    expect(readGated).toEqual([]);
  });

  it('lets no read-only role make any move', () => {
    // The harm the rule above prevents, asserted directly rather than inferred
    // from the naming convention -- a scope called `staff:observe` would pass
    // the suffix test and fail this one.
    const escalating: string[] = [];

    for (const role of (Object.keys(ROLE_SCOPES) as StaffRole[]).filter(isReadOnlyRole)) {
      const held = new Set<string>(ROLE_SCOPES[role]);
      for (const rule of TRANSITIONS) {
        if (rule.actors.includes('staff') && held.has(rule.requires)) {
          escalating.push(`${role} could make ${rule.from} -> ${rule.to}`);
        }
      }
    }

    expect(escalating).toEqual([]);
  });

  it('has a read-only role to check against, so neither test is vacuous', () => {
    // Both assertions above pass trivially if `isReadOnlyRole` never matches.
    expect((Object.keys(ROLE_SCOPES) as StaffRole[]).filter(isReadOnlyRole)).toContain('auditor');
  });
});
