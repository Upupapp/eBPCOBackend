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
  /** Marks one token as exchanged. A second exchange of the same token is a replay. */
  markConsumed(id: string, at: Date): Promise<void>;
  /** Revokes every token in a family. Used on sign-out, on reset, and on replay. */
  revokeFamily(familyId: string, at: Date): Promise<number>;
  /** Revokes every family belonging to an account -- "sign out everywhere". */
  revokeAllForAccount(accountId: string, at: Date): Promise<number>;
  countActiveFamilies(accountId: string): Promise<number>;
}
