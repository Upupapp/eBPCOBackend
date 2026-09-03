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
  /**
   * Persists an account and, for an applicant, their profile — TOGETHER.
   *
   * `profile` is a parameter rather than a field on `Account` for the reason
   * `profileOf` is separate: these fields exist only for applicants, and an
   * `Account` carrying them for every officer invites a caller to read them
   * without checking `kind`.
   *
   * It must be written in the SAME transaction as the account. Until
   * 2026-08-31 it was not written at all: registration validated a first name,
   * a last name and a mobile number, then discarded all three, and the account
   * it created could never file anything — every write path refused it with
   * "This account has no applicant profile". An account that exists and cannot
   * act is worse than a registration that failed, because it looks like success.
   */
  save(account: Account, profile?: ApplicantProfile): Promise<void>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  /** Stamped after a sign-in has passed every check, including MFA. */
  recordSignIn(id: string, at: Date): Promise<void>;
  /**
   * The applicant's own details, if this account is one.
   *
   * Separate from `findById` rather than folded into `Account`, because these
   * fields exist only for applicants and an `Account` carrying two
   * always-null columns for every officer invites a caller to read them
   * without checking `kind`.
   */
  profileOf(accountId: string): Promise<ApplicantProfile | null>;

  /**
   * A staff account's access level, or null where it has no assignment.
   *
   * Read at token issue, so a level a super admin changes takes effect on the
   * officer's next sign-in rather than being frozen into whatever token they
   * happened to hold. Null means unassigned, and `scopesFor` treats that as the
   * role's own scopes — the level narrows, it never grants.
   */
  accessLevelOf(accountId: string): Promise<'view' | 'view-edit' | null>;
}

export interface ApplicantProfile {
  readonly firstName: string;
  /** Optional in fact, not just in type: many people do not use one. */
  readonly middleName: string | null;
  readonly lastName: string;
  readonly mobileNumber: string | null;
  /**
   * Where the office writes to this applicant about an application (migration
   * 036). Distinct from `applications.location`, which is the site, and from
   * `businesses.street`, which is where a business operates.
   *
   * Every part nullable and null means NOT RECORDED: the data was never
   * collected before 036, so every existing applicant has none of it, and a
   * client must not render null as blank-and-confirmed.
   */
  readonly street: string | null;
  readonly barangay: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
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
