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
  | 'administrator';

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
  | 'staff:evaluate'
  | 'staff:assess'
  | 'staff:verify-payment'
  | 'staff:approve'
  | 'staff:release'
  | 'staff:administer';

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
  'receiving-officer': ['applications:read', 'documents:read'],
  'records-officer': ['applications:read', 'documents:read', 'documents:write'],
  evaluator: ['applications:read', 'documents:read', 'staff:evaluate'],
  assessor: ['applications:read', 'payments:read', 'staff:assess'],
  cashier: ['applications:read', 'payments:read', 'staff:verify-payment'],
  'building-official': ['applications:read', 'documents:read', 'payments:read', 'staff:approve'],
  'releasing-officer': ['applications:read', 'staff:release'],
  administrator: ['staff:administer'],
};

/**
 * Roles whose holder can approve, assess, or release a permit -- the acts with
 * money or a legal instrument at the end of them. MFA is mandatory for these.
 */
export const MFA_REQUIRED_ROLES: readonly StaffRole[] = [
  'assessor', 'cashier', 'building-official', 'releasing-officer', 'administrator',
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

export function scopesFor(account: Pick<Account, 'kind' | 'roles'>): readonly Scope[] {
  if (account.kind === 'applicant') return APPLICANT_SCOPES;
  const granted = new Set<Scope>();
  for (const role of account.roles) {
    for (const scope of ROLE_SCOPES[role]) granted.add(scope);
  }
  return [...granted];
}

export function requiresMfa(account: Pick<Account, 'kind' | 'roles'>): boolean {
  if (account.kind !== 'staff') return false;
  return account.roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
}
