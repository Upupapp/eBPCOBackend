import { AccountRepository, normaliseEmail } from '../application/account.repository';
import { Account } from '../domain/account';

/** TAB 04 replaces this with PostgreSQL. The port is what the domain depends on. */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly byId = new Map<string, Account>();
  private readonly idByEmail = new Map<string, string>();

  findById(id: string): Promise<Account | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  findByEmail(email: string): Promise<Account | null> {
    const id = this.idByEmail.get(normaliseEmail(email));
    return Promise.resolve(id === undefined ? null : (this.byId.get(id) ?? null));
  }

  save(account: Account): Promise<void> {
    this.byId.set(account.id, account);
    this.idByEmail.set(normaliseEmail(account.email), account.id);
    return Promise.resolve();
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const account = this.byId.get(id);
    if (account !== undefined) this.byId.set(id, { ...account, passwordHash });
    return Promise.resolve();
  }
}
