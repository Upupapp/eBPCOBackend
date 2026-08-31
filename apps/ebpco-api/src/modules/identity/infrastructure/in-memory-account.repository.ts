import { AccountRepository, ApplicantProfile, normaliseEmail } from '../application/account.repository';
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

  save(account: Account, profile?: ApplicantProfile): Promise<void> {
    this.byId.set(account.id, account);
    this.idByEmail.set(normaliseEmail(account.email), account.id);
    // Written here for the same reason the Postgres one writes it in its
    // transaction: an account saved without its profile is an account that
    // cannot act, and the shared contract suite holds both to that.
    if (profile !== undefined) this.profiles.set(account.id, profile);
    return Promise.resolve();
  }

  private readonly profiles = new Map<string, ApplicantProfile>();

  /** Set by tests that need `/me` to answer with a name. */
  setProfile(accountId: string, profile: ApplicantProfile): void {
    this.profiles.set(accountId, profile);
  }

  profileOf(accountId: string): Promise<ApplicantProfile | null> {
    return Promise.resolve(this.profiles.get(accountId) ?? null);
  }

  private readonly signedInAt = new Map<string, Date>();

  /**
   * Kept here rather than on `Account`, because nothing reads it through the
   * port: the staff directory selects it directly, and adding a field to the
   * account every consumer carries in order to serve one screen is how a
   * domain type turns into a row.
   */
  recordSignIn(id: string, at: Date): Promise<void> {
    this.signedInAt.set(id, at);
    return Promise.resolve();
  }

  /** What `recordSignIn` last stamped, for the contract test. */
  lastSignInAt(id: string): Date | null {
    return this.signedInAt.get(id) ?? null;
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const account = this.byId.get(id);
    if (account !== undefined) this.byId.set(id, { ...account, passwordHash });
    return Promise.resolve();
  }
}
