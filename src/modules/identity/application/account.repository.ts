import { Account } from '../domain/account';

/**
 * Injection token. Declared beside the port rather than in the module that
 * binds it: a token defined in the module forces every consumer to import the
 * module, and the module imports the consumers, which is a cycle that resolves
 * to `undefined` at exactly the wrong moment.
 */
export const ACCOUNT_REPOSITORY = Symbol('EBPCO_ACCOUNT_REPOSITORY');

export interface AccountRepository {
  findById(id: string): Promise<Account | null>;
  /** Lookup is by normalised email; see `normaliseEmail`. */
  findByEmail(email: string): Promise<Account | null>;
  save(account: Account): Promise<void>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  /**
   * The applicant's own details, if this account is one.
   *
   * Separate from `findById` rather than folded into `Account`, because these
   * fields exist only for applicants and an `Account` carrying two
   * always-null columns for every officer invites a caller to read them
   * without checking `kind`.
   */
  profileOf(accountId: string): Promise<ApplicantProfile | null>;
}

export interface ApplicantProfile {
  readonly firstName: string;
  readonly lastName: string;
  readonly mobileNumber: string | null;
}

/**
 * One canonical form for an address, so `Maria.Santos@Example.PH` and
 * `maria.santos@example.ph` are one account rather than two.
 *
 * Case-folded on the domain, which is case-insensitive by RFC 1035, and on the
 * local part, which strictly is not -- but treating them as distinct would let
 * two accounts exist that every applicant would consider the same, and that is
 * an account-takeover vector rather than a nicety.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
