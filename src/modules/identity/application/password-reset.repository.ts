import { createHash } from 'node:crypto';

/**
 * Outstanding password resets.
 *
 * This existed as a `Map` on the identity service, and the table it was
 * supposed to be using has been in the schema — registered, purged nightly,
 * deleted on erasure — sitting empty since it was created. Three things
 * followed from that, and none of them would have shown up in a test:
 *
 * **Password reset does not work behind more than one replica.** The applicant
 * asks for a reset on one instance, clicks the link, and the request reaches a
 * different one, which has never heard of the ticket. With three replicas it
 * fails two times in three, and the applicant is told their link is invalid.
 *
 * **A deploy invalidates every outstanding reset.** Restart the process and
 * everyone mid-recovery starts again.
 *
 * **The raw token was held in memory as the key.** The table stores a DIGEST,
 * on purpose: a leak of the reset store should not hand over usable tokens.
 * Keying a Map by the token itself throws that property away.
 *
 * For a service where this is the only way back in for someone locked out, the
 * first of those is the one that matters most.
 */

/** The DI token. Beside the port, so a controller importing the port cannot miss it. */
export const PASSWORD_RESET_REPOSITORY = Symbol('EBPCO_PASSWORD_RESET_REPOSITORY');

export interface PasswordResetTicketRecord {
  readonly accountId: string;
  readonly expiresAt: Date;
}

export interface PasswordResetRepository {
  /**
   * Issues a ticket, invalidating any the account already has.
   *
   * Requesting a second reset must retire the first. Otherwise a ticket
   * triggered earlier — possibly by somebody else, since anyone can start a
   * reset for any address — stays usable for its full window alongside the one
   * the applicant is actually looking at.
   */
  issue(digest: string, accountId: string, issuedAt: Date, expiresAt: Date): Promise<void>;

  /**
   * Redeems a ticket, exactly once.
   *
   * Redemption and the single-use check are ONE statement. Reading the ticket
   * and then marking it used is a check-then-act, and two requests arriving
   * together both pass the check — which for a password reset means two people
   * setting a password on the same account.
   */
  redeem(digest: string, at: Date): Promise<PasswordResetTicketRecord | null>;
}

/**
 * What is stored, and what is never stored.
 *
 * The token goes to the applicant by email; only its digest is kept, so the
 * store cannot be turned back into a working link. SHA-256 without a salt is
 * right here and would be wrong for a password: the input is 128 bits of
 * randomness rather than something guessable, so there is no dictionary to
 * build and nothing for a salt to defeat.
 */
export function resetTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
