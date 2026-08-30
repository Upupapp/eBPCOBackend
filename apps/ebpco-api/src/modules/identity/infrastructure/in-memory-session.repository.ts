import { SessionRepository } from '../application/session.repository';
import { StoredRefreshToken } from '../domain/tokens';

/**
 * The refresh-token store, in memory.
 *
 * TAB 04 replaces this with PostgreSQL. It exists so the identity logic is
 * testable without a database -- logic that can only be tested through a
 * database tends to be tested through HTTP instead, and then not at all.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly tokens = new Map<string, StoredRefreshToken>();

  save(token: StoredRefreshToken): Promise<void> {
    this.tokens.set(token.id, token);
    return Promise.resolve();
  }

  findById(id: string): Promise<StoredRefreshToken | null> {
    return Promise.resolve(this.tokens.get(id) ?? null);
  }

  markConsumed(id: string, at: Date): Promise<void> {
    const token = this.tokens.get(id);
    if (token !== undefined) this.tokens.set(id, { ...token, consumedAt: at });
    return Promise.resolve();
  }

  /** The revoked set stands in for the `revoked_sessions` table. */
  readonly revokedFamilies = new Map<string, Date>();

  revokeFamily(familyId: string, at: Date, accessTokenTtlSeconds: number): Promise<number> {
    this.revokedFamilies.set(familyId, new Date(at.getTime() + accessTokenTtlSeconds * 1000));
    let revoked = 0;
    for (const [id, token] of this.tokens) {
      if (token.familyId === familyId && token.revokedAt === null) {
        this.tokens.set(id, { ...token, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  revokeAllForAccount(accountId: string, at: Date, accessTokenTtlSeconds: number): Promise<number> {
    for (const token of this.tokens.values()) {
      if (token.accountId === accountId) {
        this.revokedFamilies.set(token.familyId, new Date(at.getTime() + accessTokenTtlSeconds * 1000));
      }
    }
    let revoked = 0;
    for (const [id, token] of this.tokens) {
      if (token.accountId === accountId && token.revokedAt === null) {
        this.tokens.set(id, { ...token, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  countActiveFamilies(accountId: string): Promise<number> {
    const families = new Set<string>();
    for (const token of this.tokens.values()) {
      if (token.accountId === accountId && token.revokedAt === null && token.consumedAt === null) {
        families.add(token.familyId);
      }
    }
    return Promise.resolve(families.size);
  }
}
