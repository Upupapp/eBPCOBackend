/**
 * The two populations this service authenticates, and what each may do.
 *
 * One mechanism for both, so there is one place to get authentication right --
 * but the populations are distinguished by type rather than by a flag, because
 * "is this an applicant or an officer" is a question the authorisation layer
 * must never get wrong by reading a boolean the wrong way round.
 */

export type AccountKind = 'applicant' | 'staff';

/**
 * Staff roles. An applicant has no role: their authority comes entirely from
 * owning the record they are acting on.
 */
export type StaffRole =
  | 'receiving-officer'
  | 'records-officer'
  | 'evaluator'
  | 'assessor'
  | 'cashier'
  | 'building-official'
  | 'releasing-officer'
  | 'administrator'
  | 'auditor'
  | 'super-admin';

/**
 * What a token bears. Deliberately coarse: fine-grained permission lives in the
 * domain layer, where the object being acted on is in scope. A scope says what
 * kind of operation a caller may attempt; whether they may attempt it on THIS
 * application is a question only the lifecycle engine can answer.
 */
export type Scope =
  | 'applications:read'
  | 'applications:write'
  | 'documents:read'
  | 'documents:write'
  | 'payments:read'
  | 'payments:write'
  | 'notifications:read'
  | 'notifications:write'
  | 'profile:read'
  | 'profile:write'
  /**
   * Intake. Added 2026-08-30 to close a hole, not to add a feature.
   *
   * `receiving-officer` was the only ACTING role with no acting scope: every
   * other one has evaluate, assess, verify-payment, approve or release, and it
   * had two read scopes. So the two intake transitions were gated on the
   * weakest thing available -- `applications:read` and `documents:read` -- and a
   * READ scope authorising a state change grants that change to every role
   * holding it. `auditor` holds both by design, which meant the
   * read-everything-change-nothing role could move an application through
   * intake. Nothing caught it, because a separate bug left the auditor unable
   * to SEE any application; the guarantee was being enforced by a defect.
   */
  | 'staff:receive'
  | 'staff:evaluate'
  | 'staff:assess'
  | 'staff:verify-payment'
  | 'staff:approve'
  | 'staff:release'
  | 'staff:administer'
  | 'audit:read';

/**
 * The union, at runtime. Needed since D-5: the workflow editor accepts a scope
 * from an HTTP client, and a move requiring a scope that does not exist is a
 * move no officer can ever make -- an edge in the graph and a dead end in
 * practice.
 */
export const ALL_SCOPES = [
  'applications:read', 'applications:write',
  'documents:read', 'documents:write',
  'payments:read', 'payments:write',
  'notifications:read', 'notifications:write',
  'profile:read', 'profile:write',
  'staff:receive', 'staff:evaluate', 'staff:assess', 'staff:verify-payment',
  'staff:approve', 'staff:release', 'staff:administer',
  'audit:read',
] as const satisfies readonly Scope[];

/**
 * Compiles to nothing and exists to fail: adding a scope to the union without
 * adding it above makes this a type error, rather than a validator that quietly
 * rejects a scope the rest of the system honours.
 */
export type EveryScopeIsListed = Exclude<Scope, (typeof ALL_SCOPES)[number]> extends never
  ? true : never;

/**
 * Whether a scope confers AUTHORITY rather than sight.
 *
 * `:read` scopes let a caller look; `:write` and `staff:*` scopes let them act.
 * The distinction has to be computable because a transition rule names a scope
 * as its authority, and a rule naming a read scope grants that act to everyone
 * holding it -- which is how `auditor`, defined as "read everything, change
 * nothing", could move an application through intake until 2026-08-30.
 */
export const grantsAuthority = (scope: string): boolean =>
  scope.endsWith(':write') || scope.startsWith('staff:');

export const APPLICANT_SCOPES: readonly Scope[] = [
  'applications:read', 'applications:write',
  'documents:read', 'documents:write',
  'payments:read', 'payments:write',
  'notifications:read', 'notifications:write',
  'profile:read', 'profile:write',
];

/**
 * Least privilege, per role. An evaluator cannot verify a payment; a cashier
 * cannot approve a permit. Separation of duty is the point: the officer who
 * assesses a fee must not also be the one who confirms it was paid.
 */
export const ROLE_SCOPES: Readonly<Record<StaffRole, readonly Scope[]>> = {
  'receiving-officer': ['applications:read', 'documents:read', 'staff:receive'],
  // `applications:write` because withdrawing an application on the applicant's
  // behalf, or expiring one after inaction, is maintenance of the record --
  // which is what this role exists to do. Its absence made three staff
  // transitions (Submitted/Received/Revision Required -> Cancelled, and
  // Revision Required -> Expired) unreachable by any real officer: the rules
  // required a scope no role granted. A table-driven test over the transitions
  // caught it; no individual test would have, because each was written against
  // a caller holding every scope.
  // `staff:receive` as well: the records officer already saw every status and
  // performed intake in practice, and the transitions must stay reachable by a
  // second role -- an office with one receiving officer on leave still has to
  // receive applications.
  'records-officer': [
    'applications:read', 'applications:write', 'documents:read', 'documents:write',
    'staff:receive',
  ],
  evaluator: ['applications:read', 'documents:read', 'staff:evaluate'],
  assessor: ['applications:read', 'payments:read', 'staff:assess'],
  cashier: ['applications:read', 'payments:read', 'staff:verify-payment'],
  'building-official': ['applications:read', 'documents:read', 'payments:read', 'staff:approve'],
  'releasing-officer': ['applications:read', 'staff:release'],
  administrator: ['staff:administer'],

  // ── added by the web-portal reconciliation (WP-01) ───────────────────
  //
  // READ EVERYTHING, CHANGE NOTHING. Until now every role that could read
  // could also act, so there was no way to give someone oversight without
  // giving them authority — which is the whole point of the position. The
  // absence of a write scope here is the definition of the role, not an
  // omission to be filled in later.
  auditor: ['applications:read', 'documents:read', 'payments:read', 'audit:read'],

  // The portal's Super Admin. It holds every READ scope and the administration
  // scope, and DELIBERATELY NOT the four acting scopes -- assess, verify,
  // approve, release.
  //
  // Seeing every screen is not the same as being able to perform every act.
  // Granting all sixteen scopes to one role would dissolve the separation of
  // duty the rest of this table exists to enforce: the officer who assesses a
  // fee must not be the one who confirms it was paid, and a role that can do
  // both makes that rule unenforceable by anyone holding it. An administrator
  // who genuinely needs to assess can be given the assessor role as well --
  // visibly, in the role table, where it can be audited.
  'super-admin': [
    'applications:read', 'applications:write',
    'documents:read', 'documents:write',
    'payments:read', 'notifications:read',
    'audit:read', 'staff:administer',
  ],
};

/**
 * A role that may look at everything it is shown and change none of it.
 *
 * Not a list, because a list is a second place to update. `auditor` is the only
 * one today; the point is that adding another must not silently become a role
 * that can act, and that a transition rule must never name a scope such a role
 * holds.
 */
export const isReadOnlyRole = (role: StaffRole): boolean =>
  !ROLE_SCOPES[role].some(grantsAuthority);


/**
 * The staff web portal's role names, mapped to this table's.
 *
 * The portal and this service grew separate vocabularies -- seven names against
 * eight, three of which happened to agree. Reconciled in ONE direction: these
 * role identifiers are the wire vocabulary, and the portal's names are display
 * labels over them. The alternative, translating at the edge, means two lists
 * that must be kept in step by whoever remembers, and an authorisation decision
 * is the last place to put a mapping nobody owns.
 *
 * `Payment Officer` deliberately has NO single entry. The portal had one role
 * where this table has two, and collapsing them would silently merge assessing
 * a fee with confirming its payment. That is the separation of duty above, so
 * the portal shows two roles.
 */
export const PORTAL_ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  'receiving-officer': 'Receiving Officer',
  'records-officer': 'Records Officer',
  evaluator: 'Evaluator',
  assessor: 'Assessor',
  cashier: 'Cashier',
  'building-official': 'Approving Officer',
  'releasing-officer': 'Releasing Officer',
  administrator: 'Administrator',
  auditor: 'Auditor',
  'super-admin': 'Super Admin',
};

/**
 * Roles whose holder can approve, assess, or release a permit -- the acts with
 * money or a legal instrument at the end of them. MFA is mandatory for these.
 */
export const MFA_REQUIRED_ROLES: readonly StaffRole[] = [
  'assessor', 'cashier', 'building-official', 'releasing-officer', 'administrator',
  // A super-admin can create and role other officers, which is authority over
  // every act in the list above even though it performs none of them directly.
  'super-admin',
];

export interface Account {
  readonly id: string;
  readonly kind: AccountKind;
  readonly email: string;
  /** The scrypt verifier. Never leaves the persistence layer. */
  readonly passwordHash: string;
  readonly roles: readonly StaffRole[];
  readonly emailVerifiedAt: Date | null;
  readonly mobileVerifiedAt: Date | null;
  readonly totpSecret: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Reading and managing your OWN account is not a job function.
 *
 * The role table grants what an officer may do to other people's permits. It
 * said nothing about their own record, which meant a staff token carried no
 * `profile:*` scope at all — and the moment the `/me` routes were scope-gated,
 * an officer could not read their own profile, request their own data export,
 * or exercise erasure.
 *
 * That is a compliance gap rather than an inconvenience: RA 10173 rights belong
 * to the person, and an officer of the LGU is as much a data subject as an
 * applicant is. Nothing about holding a job removes them.
 *
 * Granted to every account rather than added to each of the eight roles,
 * because it is a property of having an account and not of any role — and a
 * per-role list is one somebody adds a ninth role to without noticing.
 */
const SELF_SCOPES: readonly Scope[] = ['profile:read', 'profile:write'];

export function scopesFor(account: Pick<Account, 'kind' | 'roles'>): readonly Scope[] {
  if (account.kind === 'applicant') return APPLICANT_SCOPES;
  const granted = new Set<Scope>(SELF_SCOPES);
  for (const role of account.roles) {
    for (const scope of ROLE_SCOPES[role]) granted.add(scope);
  }
  return [...granted];
}

export function requiresMfa(account: Pick<Account, 'kind' | 'roles'>): boolean {
  if (account.kind !== 'staff') return false;
  return account.roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
}
