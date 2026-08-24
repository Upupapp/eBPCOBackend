import { SqlClient } from '../../../persistence/sql-client';
import {
  PasswordResetRepository,
  PasswordResetTicketRecord,
} from '../application/password-reset.repository';

export class PostgresPasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly db: SqlClient) {}

  async issue(digest: string, accountId: string, issuedAt: Date, expiresAt: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Any ticket this account already holds is retired first. Anyone can
      // start a reset for any address, so an unretired earlier ticket is one
      // somebody else may have triggered and may be holding.
      await tx.query(
        'update password_reset_tickets set used_at = $2 where account_id = $1 and used_at is null',
        [accountId, issuedAt],
      );
      await tx.query(
        `insert into password_reset_tickets (token_digest, account_id, issued_at, expires_at)
         values ($1,$2,$3,$4)
         on conflict (token_digest) do nothing`,
        [digest, accountId, issuedAt, expiresAt],
      );
    });
  }

  async redeem(digest: string, at: Date): Promise<PasswordResetTicketRecord | null> {
    // One statement. Reading the ticket and then marking it used is a
    // check-then-act: two requests arriving together both pass the check, and
    // for a password reset that means two people setting a password on one
    // account. The WHERE carries the expiry as well, so an expired ticket is
    // not consumed — it simply does not match.
    const result = await this.db.query<{ account_id: string; expires_at: Date }>(
      `update password_reset_tickets
          set used_at = $2
        where token_digest = $1 and used_at is null and expires_at > $2
        returning account_id, expires_at`,
      [digest, at],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { accountId: row.account_id, expiresAt: new Date(row.expires_at) };
  }
}
