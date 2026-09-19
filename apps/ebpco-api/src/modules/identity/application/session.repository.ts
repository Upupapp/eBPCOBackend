import { StoredRefreshToken } from '../domain/tokens';

/** Injection token. Declared beside the port, for the reason given in account.repository.ts. */
export const SESSION_REPOSITORY = Symbol('EBPCO_SESSION_REPOSITORY');

/**
 * Where refresh tokens live.
 *
 * A port, not an implementation: TAB 04 supplies the PostgreSQL adapter, and
 * the in-memory one beside it is what the tests and the mock build use. The
 * identity logic must be testable without a database, or it will only ever be
 * tested through one.
 */
export interface SessionRepository {
  save(token: StoredRefreshToken): Promise<void>;
  findById(id: string): Promise<StoredRefreshToken | null>;
  /**
   * Marks one token as exchanged, atomically: the underlying write only
   * succeeds if the token was not already consumed, and the return value is
   * that outcome, not a guess reconstructed from a separate read.
   *
   * Returns `false` on a second call for the same token -- concurrent or
   * not. Two requests presenting the same refresh token at once must not
   * both be able to read "not yet consumed" and then both write "consumed"
   * as if they were the only one; the caller needs to know it LOST that
   * race, not just that the token is consumed now, because losing it is
   * itself the replay signal.
   */
  markConsumed(id: string, at: Date): Promise<boolean>;
  /** Revokes every token in a family. Used on sign-out, on reset, and on replay. */
  /**
   * Ends a family, and RECORDS that it ended.
   *
   * Both halves matter and they stop different things. Revoking the refresh
   * token stops new access tokens being minted; the record stops one already
   * minted from being accepted. Without the second, signing out of a lost
   * handset did nothing for up to fifteen minutes.
   *
   * `accessTokenTtlSeconds` is how long the record needs to outlive the
   * revocation — past that, any token bearing the family has expired anyway.
   */
  revokeFamily(familyId: string, at: Date, accessTokenTtlSeconds: number): Promise<number>;
  /** Revokes every family belonging to an account -- "sign out everywhere". */
  revokeAllForAccount(accountId: string, at: Date, accessTokenTtlSeconds: number): Promise<number>;
  countActiveFamilies(accountId: string): Promise<number>;
}
