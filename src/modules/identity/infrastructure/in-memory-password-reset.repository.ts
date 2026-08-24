import {
  PasswordResetRepository,
  PasswordResetTicketRecord,
} from '../application/password-reset.repository';

/**
 * The in-memory adapter, for unit tests that do not want a database.
 *
 * It stores the DIGEST, exactly as the Postgres one does. An in-memory stand-in
 * that keyed by the raw token would be easier and would let the real defect —
 * a store holding usable reset links — pass its tests.
 */
export class InMemoryPasswordResetRepository implements PasswordResetRepository {
  private readonly tickets = new Map<string, { accountId: string; expiresAt: Date; usedAt: Date | null }>();

  issue(digest: string, accountId: string, issuedAt: Date, expiresAt: Date): Promise<void> {
    for (const [key, ticket] of this.tickets) {
      if (ticket.accountId === accountId && ticket.usedAt === null) {
        this.tickets.set(key, { ...ticket, usedAt: issuedAt });
      }
    }
    this.tickets.set(digest, { accountId, expiresAt, usedAt: null });
    return Promise.resolve();
  }

  redeem(digest: string, at: Date): Promise<PasswordResetTicketRecord | null> {
    const ticket = this.tickets.get(digest);
    if (ticket === undefined || ticket.usedAt !== null || ticket.expiresAt.getTime() <= at.getTime()) {
      return Promise.resolve(null);
    }
    this.tickets.set(digest, { ...ticket, usedAt: at });
    return Promise.resolve({ accountId: ticket.accountId, expiresAt: ticket.expiresAt });
  }
}
