import {
  ROLE_SCOPES, Scope, StaffRole, grantsAuthority, isReadOnlyRole, scopesFor,
} from './account';
import { ACCESS_LEVELS, AccessLevel, NO_ACCESS, StaffAccess, mayAct, mayWorkOn } from './staff-access';

/** The derivation under test lives in account.ts; this is the shape it takes. */
const scopesAt = (role: StaffRole, level: AccessLevel): readonly Scope[] =>
  scopesFor({ kind: 'staff', roles: [role] }, level)
    .filter((scope) => (ROLE_SCOPES[role]).includes(scope));

const scopesForRolesAt = (roles: readonly StaffRole[], level: AccessLevel): readonly Scope[] =>
  scopesFor({ kind: 'staff', roles }, level);

/**
 * Table-driven over role × level, because that is what found the last one.
 *
 * The auditor defect — a read-everything-change-nothing role that could move an
 * application through intake — survived because every individual test was
 * written against a caller holding every scope. A table has no such caller.
 */

const ROLES: readonly StaffRole[] = [
  'receiving-officer', 'records-officer', 'evaluator', 'assessor', 'cashier',
  'building-official', 'releasing-officer', 'administrator', 'auditor', 'super-admin',
];

const PERMIT_TYPES = ['New Construction', 'Renovation', 'Demolition', 'Electrical'];

const access = (level: AccessLevel, permitTypes: readonly string[]): StaffAccess =>
  ({ level, permitTypes });

describe('a level narrows a role and can never widen it', () => {
  const table = ROLES.flatMap((role) => ACCESS_LEVELS.map((level) => ({ role, level })));

  it.each(table)('$role at $level holds only scopes the role already had', ({ role, level }) => {
    const held = new Set<Scope>(ROLE_SCOPES[role]);

    for (const scope of scopesAt(role, level)) {
      expect(held.has(scope)).toBe(true);
    }
  });

  it.each(ROLES)('%s at view holds no scope that grants authority', (role) => {
    // The whole definition of 'view'. Derived from grantsAuthority(), so a
    // scope added to the union later is classified without anyone editing this.
    for (const scope of scopesAt(role, 'view')) {
      expect(grantsAuthority(scope)).toBe(false);
    }
  });

  it.each(ROLES)('%s at view-edit holds exactly the role scopes', (role) => {
    expect([...scopesAt(role, 'view-edit')].sort())
      .toEqual([...ROLE_SCOPES[role]].sort());
  });

  it('does not let a level grant a scope belonging to a different role', () => {
    // Separation of duty must survive the level system. An evaluator raised to
    // view-edit must not acquire the cashier's payment verification.
    expect(scopesAt('evaluator', 'view-edit')).not.toContain('staff:verify-payment');
    expect(scopesAt('cashier', 'view-edit')).not.toContain('staff:evaluate');
  });

  it('leaves a read-only role read-only at every level', () => {
    // `auditor` is defined by the ABSENCE of authority. If view-edit could give
    // it any, the role would stop meaning what the table says it means.
    expect(isReadOnlyRole('auditor')).toBe(true);

    for (const level of ACCESS_LEVELS) {
      for (const scope of scopesAt('auditor', level)) {
        expect(grantsAuthority(scope)).toBe(false);
      }
    }
  });

  it('unions the scopes of several roles at one level', () => {
    const both = scopesForRolesAt(['evaluator', 'cashier'], 'view-edit');

    expect(both).toContain('staff:evaluate');
    expect(both).toContain('staff:verify-payment');
  });
});

describe('the forms allow-list fails closed', () => {
  it('grants nothing when it is empty, at either level', () => {
    // The case the owner named: view-edit WITH NO FORMS. Full authority over
    // nothing is the shape a missing assignment takes, and it must be inert
    // rather than unlimited.
    for (const level of ACCESS_LEVELS) {
      for (const permitType of PERMIT_TYPES) {
        expect(mayWorkOn(access(level, []), permitType)).toBe(false);
      }
    }
  });

  it('treats an unassigned account as no access, not all access', () => {
    expect(NO_ACCESS.permitTypes).toEqual([]);
    expect(mayWorkOn(NO_ACCESS, 'New Construction')).toBe(false);
  });

  it('lets view-only see every form without acting on any', () => {
    // The owner's second named case: VIEW-ONLY WITH ALL FORMS. Breadth of sight
    // and depth of authority are independent, and this is the pair most likely
    // to be conflated.
    const auditor = access('view', PERMIT_TYPES);

    for (const permitType of PERMIT_TYPES) {
      expect(mayWorkOn(auditor, permitType)).toBe(true);
    }
    expect(mayAct(auditor)).toBe(false);
  });

  it('keeps a retired permit type inert rather than erroring', () => {
    // The owner's third case: an approved request whose permit type was LATER
    // RETIRED. The grant stays readable — it explains why the officer had
    // access — and simply matches nothing live. Retirement is a flag, never a
    // delete, so the row cannot dangle.
    const granted = access('view-edit', ['Sanitary/Plumbing']);

    expect(mayWorkOn(granted, 'Sanitary/Plumbing')).toBe(true);
    expect(mayWorkOn(granted, 'New Construction')).toBe(false);
  });

  it('is case- and whitespace-exact, because these are keys not labels', () => {
    // Internal keys, never published names. A near-match must NOT be treated as
    // a match: 'Fencing' and 'Fencing Permit' are different vocabularies, and
    // an authorisation decision is the last place to be lenient about it.
    const granted = access('view-edit', ['New Construction']);

    expect(mayWorkOn(granted, 'new construction')).toBe(false);
    expect(mayWorkOn(granted, 'New Construction ')).toBe(false);
  });
});

describe('level and forms answer different questions', () => {
  const table = [
    { level: 'view' as const, forms: PERMIT_TYPES, act: false, see: true },
    { level: 'view' as const, forms: [], act: false, see: false },
    { level: 'view-edit' as const, forms: PERMIT_TYPES, act: true, see: true },
    { level: 'view-edit' as const, forms: [], act: true, see: false },
  ];

  it.each(table)('level=$level forms=$forms.length', ({ level, forms, act, see }) => {
    // The fourth row is the one worth staring at: mayAct is TRUE and the
    // officer can still reach nothing. Authority and reach are independent, and
    // a check that collapsed them would let an unassigned view-edit account
    // through on the strength of its level alone.
    const granted = access(level, forms);

    expect(mayAct(granted)).toBe(act);
    expect(mayWorkOn(granted, 'New Construction')).toBe(see);
  });
});
