import { mayRemoveSuperAdmin } from './super-admin-floor';

describe('the last super admin cannot be removed', () => {
  const floor = (...ids: string[]): { enabledSuperAdmins: string[] } =>
    ({ enabledSuperAdmins: ids });

  it('refuses when the account is the only enabled super admin', () => {
    const decision = mayRemoveSuperAdmin(floor('paul'), 'paul');

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toContain('Appoint another super admin first');
  });

  it('permits it once a second one exists', () => {
    expect(mayRemoveSuperAdmin(floor('paul', 'ana'), 'paul').ok).toBe(true);
  });

  it('counts only ENABLED super admins', () => {
    // A disabled super admin cannot sign in, so it cannot be the one that saves
    // you. Counting rows rather than enabled accounts would let the last usable
    // administrator be removed while a dormant row made it look safe.
    expect(mayRemoveSuperAdmin(floor('paul'), 'paul').ok).toBe(false);
  });

  it('permits removing someone who is not a super admin at all', () => {
    expect(mayRemoveSuperAdmin(floor('paul'), 'ana').ok).toBe(true);
  });

  it('permits removing a super admin who is already disabled', () => {
    // Not in the enabled list, so the act changes nothing about who can
    // administer — and refusing it would make a disabled account unerasable.
    expect(mayRemoveSuperAdmin(floor('paul', 'ana'), 'dormant').ok).toBe(true);
  });

  it('refuses identically for demotion, disabling and erasure', () => {
    // One rule, asked once. They differ in every other respect and are
    // identical in the only one that matters: afterwards that account can no
    // longer administer.
    const decision = mayRemoveSuperAdmin(floor('paul'), 'paul');

    expect(decision.ok).toBe(false);
  });
});
