import { randomUUID } from 'node:crypto';

import { AccountRepository, ApplicantProfile, normaliseEmail } from '../application/account.repository';
import { Account, StaffRole } from '../domain/account';
import { SqlClient } from '../../../persistence/sql-client';

interface AccountRow {
  id: string;
  kind: 'applicant' | 'staff';
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  mobile_verified_at: Date | null;
  totp_secret_encrypted: Buffer | null;
  disabled_at: Date | null;
  created_at: Date;
  roles: string[] | null;
}

const SELECT = `
  select a.id, a.kind, a.email, a.password_hash, a.email_verified_at, a.mobile_verified_at,
         a.totp_secret_encrypted, a.disabled_at, a.created_at,
         coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from accounts a
    left join account_roles r on r.account_id = a.id
`;

/**
 * The PostgreSQL account store.
 *
 * Held to the same contract as the in-memory one by a shared test suite, so
 * "works in tests, fails in production" cannot happen quietly: any behaviour
 * one has and the other does not is a failing test rather than an incident.
 */
export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly db: SqlClient) {}

  async findById(id: string): Promise<Account | null> {
    const result = await this.db.query<AccountRow>(`${SELECT} where a.id = $1 group by a.id`, [id]);
    return this.toAccount(result.rows[0]);
  }

  async findByEmail(email: string): Promise<Account | null> {
    const result = await this.db.query<AccountRow>(
      `${SELECT} where a.email_normalised = $1 group by a.id`,
      [normaliseEmail(email)],
    );
    return this.toAccount(result.rows[0]);
  }

  async save(account: Account, profile?: ApplicantProfile): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into accounts (id, kind, email, email_normalised, password_hash,
                               mobile_number,
                               email_verified_at, mobile_verified_at, disabled_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do update set
           email             = excluded.email,
           email_normalised  = excluded.email_normalised,
           password_hash     = excluded.password_hash,
           -- Only when one is supplied. An update that omits the profile must
           -- not blank a mobile number the account already verified.
           mobile_number     = coalesce(excluded.mobile_number, accounts.mobile_number),
           email_verified_at = excluded.email_verified_at,
           mobile_verified_at= excluded.mobile_verified_at,
           disabled_at       = excluded.disabled_at,
           updated_at        = now()`,
        [
          account.id, account.kind, account.email, normaliseEmail(account.email),
          account.passwordHash, profile?.mobileNumber ?? null,
          account.emailVerifiedAt, account.mobileVerifiedAt,
          account.disabledAt, account.createdAt,
        ],
      );

      // The applicant row, in the SAME transaction. An account without one
      // exists and cannot act: every applicant write path refuses it with
      // "This account has no applicant profile", and there is no route that
      // creates one afterwards.
      if (profile !== undefined) {
        await tx.query(
          `insert into applicants (id, account_id, first_name, last_name)
           values ($1, $2, $3, $4)
           on conflict (account_id) do update set
             first_name = excluded.first_name,
             last_name  = excluded.last_name`,
          [randomUUID(), account.id, profile.firstName, profile.lastName],
        );
      }

      // Roles are replaced wholesale rather than diffed: the caller supplies the
      // complete set, and a diff would silently keep a role the caller dropped.
      await tx.query('delete from account_roles where account_id = $1', [account.id]);
      for (const role of account.roles) {
        await tx.query('insert into account_roles (account_id, role) values ($1, $2)', [account.id, role]);
      }
    });
  }

  async recordSignIn(id: string, at: Date): Promise<void> {
    await this.db.query('update accounts set last_sign_in_at = $1 where id = $2', [at, id]);
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.query('update accounts set password_hash = $1, updated_at = now() where id = $2', [
      passwordHash,
      id,
    ]);
  }

  /**
   * The applicant row behind an account, joined to the mobile number the
   * account itself carries.
   *
   * Returns null for a staff account rather than throwing: "is this an
   * applicant" is a question the caller already answered by reading `kind`,
   * and a repository that throws on the other branch makes every caller wrap
   * it.
   */
  async accessLevelOf(accountId: string): Promise<'view' | 'view-edit' | null> {
    const result = await this.db.query<{ level: string }>(
      'select level from staff_access where account_id = $1', [accountId]);
    const level = result.rows[0]?.level;
    return level === 'view' || level === 'view-edit' ? level : null;
  }

  async profileOf(accountId: string): Promise<ApplicantProfile | null> {
    const result = await this.db.query<{
      first_name: string; last_name: string; mobile_number: string | null;
    }>(
      `select ap.first_name, ap.last_name, acc.mobile_number
         from applicants ap
         join accounts acc on acc.id = ap.account_id
        where ap.account_id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      firstName: row.first_name,
      lastName: row.last_name,
      mobileNumber: row.mobile_number,
    };
  }

  private toAccount(row: AccountRow | undefined): Account | null {
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.kind,
      email: row.email,
      passwordHash: row.password_hash,
      roles: (row.roles ?? []) as StaffRole[],
      emailVerifiedAt: row.email_verified_at,
      mobileVerifiedAt: row.mobile_verified_at,
      // Decryption belongs to the key service, not here. Presence is what the
      // domain asks about; the value is fetched only when a code is verified.
      totpSecret: row.totp_secret_encrypted === null ? null : '[encrypted]',
      disabledAt: row.disabled_at,
      createdAt: row.created_at,
    };
  }
}
