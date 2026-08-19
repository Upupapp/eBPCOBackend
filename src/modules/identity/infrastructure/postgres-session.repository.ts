import { SessionRepository } from '../application/session.repository';
import { StoredRefreshToken } from '../domain/tokens';
import { SqlClient } from '../../../persistence/sql-client';

interface TokenRow {
  id: string;
  family_id: string;
  account_id: string;
  secret_digest: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: SqlClient) {}

  async save(token: StoredRefreshToken): Promise<void> {
    await this.db.query(
      `insert into refresh_tokens (id, family_id, account_id, secret_digest, issued_at, expires_at, consumed_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [token.id, token.familyId, token.accountId, token.secretDigest,
       token.issuedAt, token.expiresAt, token.consumedAt, token.revokedAt],
    );
  }

  async findById(id: string): Promise<StoredRefreshToken | null> {
    // A malformed id must return null, not throw: the id comes from a caller,
    // and `where id = $1` on a non-UUID raises a type error in PostgreSQL that
    // would turn a bad token into a 500.
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;

    const result = await this.db.query<TokenRow>(
      `select id, family_id, account_id, secret_digest, issued_at, expires_at, consumed_at, revoked_at
         from refresh_tokens where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      familyId: row.family_id,
      accountId: row.account_id,
      secretDigest: row.secret_digest,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      revokedAt: row.revoked_at,
    };
  }

  async markConsumed(id: string, at: Date): Promise<void> {
    await this.db.query('update refresh_tokens set consumed_at = $1 where id = $2 and consumed_at is null', [at, id]);
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const result = await this.db.query(
      'update refresh_tokens set revoked_at = $1 where family_id = $2 and revoked_at is null',
      [at, familyId],
    );
    return result.rowCount;
  }

  async revokeAllForAccount(accountId: string, at: Date): Promise<number> {
    const result = await this.db.query(
      'update refresh_tokens set revoked_at = $1 where account_id = $2 and revoked_at is null',
      [at, accountId],
    );
    return result.rowCount;
  }

  async countActiveFamilies(accountId: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      `select count(distinct family_id)::int as count from refresh_tokens
        where account_id = $1 and revoked_at is null and consumed_at is null`,
      [accountId],
    );
    return result.rows[0]?.count ?? 0;
  }
}
