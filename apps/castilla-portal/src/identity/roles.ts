/**
 * What each role may do.
 *
 * Five roles, and the set is deliberately small: this is a public information
 * site, not the permit transaction system. The eBPCO Web Admin's roles model
 * permit-processing duties and are not reused — a vocabulary about receiving
 * and assessing applications does not describe editing prose.
 */
export type StaffRole =
  | 'viewer'
  | 'content-editor'
  | 'content-approver'
  | 'announcements-publisher'
  | 'administrator';

export type Scope =
  | 'content:read'
  | 'content:propose'
  | 'content:confirm'
  | 'pages:edit'
  | 'announcements:publish'
  | 'accounts:manage';

/**
 * Note what an administrator does NOT get.
 *
 * Managing accounts is not a licence to edit content or confirm facts. Bundling
 * them would make the four-eyes rule optional for anyone holding the account
 * that also fixes forgotten passwords, which is precisely the account most
 * likely to be shared.
 */
const SCOPES_BY_ROLE: Readonly<Record<StaffRole, readonly Scope[]>> = {
  viewer: ['content:read'],
  'content-editor': ['content:read', 'content:propose', 'pages:edit'],
  'content-approver': ['content:read', 'content:propose', 'content:confirm'],
  'announcements-publisher': ['content:read', 'announcements:publish'],
  administrator: ['content:read', 'accounts:manage'],
};

export function scopesFor(role: StaffRole): readonly Scope[] {
  return SCOPES_BY_ROLE[role];
}

/**
 * The one read-only role, named rather than inferred.
 *
 * A sibling project's read-only guarantee turned out to be enforced by a
 * blindness bug rather than by a rule, so this is a fact the tests can assert
 * against directly: whatever scopes a viewer gains later, none of them may be
 * a write.
 */
export const READ_ONLY_ROLES: readonly StaffRole[] = ['viewer'];

const WRITE_SCOPES: readonly Scope[] = [
  'content:propose', 'content:confirm', 'pages:edit',
  'announcements:publish', 'accounts:manage',
];

export function isWriteScope(scope: Scope): boolean {
  return WRITE_SCOPES.includes(scope);
}

export function grantsAnyWrite(role: StaffRole): boolean {
  return scopesFor(role).some(isWriteScope);
}
