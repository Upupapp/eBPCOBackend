import { Account } from './account';

/**
 * Test accounts: staff accounts on the reserved `.test` top-level domain.
 *
 * RFC 6761 reserves `.test` so that no one can ever own an address on it,
 * which is what makes such an account safe to create for testing: nobody
 * outside can receive its mail, and so nobody outside can recover it.
 */
export function isReservedTestAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && /(^|\.)test$/i.test(address.slice(at + 1).trim());
}

/**
 * Whether sign-in may skip the authenticator for this account, when the
 * operator has switched that on (`MFA_EXEMPT_TEST_ACCOUNTS`, refused in
 * production): a staff test account, and never a super admin — the one
 * account that can grant every other keeps its second factor regardless.
 */
export function mfaExemptTestAccount(account: Pick<Account, 'kind' | 'email' | 'roles'>): boolean {
  return account.kind === 'staff'
    && isReservedTestAddress(account.email)
    && !account.roles.includes('super-admin');
}
