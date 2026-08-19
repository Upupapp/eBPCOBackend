import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from './audit.service';

/**
 * "Delete my account", answered honestly.
 *
 * Two laws apply and they do not agree. RA 10173 §16(e) gives a data subject
 * the right to have their personal data erased. PD 1096 and the LGU's records
 * schedule require a building permit record to be kept — a permit is evidence
 * that a structure was authorised, and it outlives the applicant's relationship
 * with the LGU by decades.
 *
 * Both are true. The two ways of pretending otherwise are equally wrong: delete
 * the permit record on request and the LGU cannot show a structure was ever
 * authorised; refuse every request because "we keep records" and the right is
 * hollow.
 *
 * What this does instead:
 *
 * **Erases** everything whose reason for existing was the relationship — the
 * login, the contact details, the credentials, the notifications, the devices,
 * the sessions. None of that is required by any statute once the person has
 * gone.
 *
 * **Keeps** the permit record, and says so in the receipt: what remains, why,
 * and under which law. A data subject is entitled to know what survives their
 * request. RA 10173 §16(e) itself is conditional on there being no overriding
 * legal obligation, so naming the obligation is what makes the refusal lawful
 * rather than merely convenient.
 *
 * **Keeps the account row as an opaque key**, holding nothing. Deleting it
 * outright would break one of the two things the erasure is meant to preserve.
 * The audit chain hashes `actor_account_id` into every entry, so nulling it
 * invalidates every entry after — destroying the very evidence that the erasure
 * was carried out. And the permit record attributes each act to an account:
 * who uploaded a document, who submitted a payment. Dropping those references
 * leaves a record that cannot say who did what.
 *
 * That is pseudonymisation, not deletion, and calling it anything else would be
 * dishonest. What makes it a real erasure is that the row holds no personal
 * data afterwards — and migration 011 enforces that with a CHECK constraint, so
 * it is a property of the database rather than a promise from this file.
 *
 * **Never touches the audit chain.** Every entry is hash-linked to the one
 * before it. The chain records that the erasure happened, which is itself the
 * evidence the LGU needs to show it honoured the request.
 */

/**
 * The shape the contract declares for `DELETE /me`.
 *
 * `until` is null for everything here, and that is not laziness. A permit
 * record has no expiry the LGU can state today: the retention schedule is the
 * LGU's to publish (M-15/M-11), and putting a plausible date on it would be
 * inventing a commitment on their behalf that an applicant might rely on. Null
 * with a named legal basis is the honest answer — "for as long as this
 * instrument requires", not "for ever" and not "until a date we made up".
 */
export interface ErasureReceipt {
  readonly acceptedAt: string;
  /** What was actually removed. Named for a person to read, not table names. */
  readonly erasedCategories: readonly string[];
  readonly retainedCategories: ReadonlyArray<{
    readonly category: string;
    readonly basis: string;
    readonly until: string | null;
  }>;
  /** Row counts, so the receipt is evidence rather than a promise. Not part of the contract shape. */
  readonly counts: Readonly<Record<string, number>>;
}

export type ErasureResult =
  | { readonly ok: true; readonly receipt: ErasureReceipt }
  | { readonly ok: false; readonly reason: 'not-found' | 'staff-account'; readonly detail: string };

/**
 * What is deleted outright, children before parents.
 *
 * Every one of these is `account-lifetime` in the register: nothing statutory
 * requires keeping a way to reach or authenticate someone who has left. A test
 * cross-checks this list against the register, so a new account-lifetime table
 * added and forgotten here fails rather than quietly leaving personal data
 * behind after an erasure that reported success.
 */
export const ERASE_IN_ORDER: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'notification_deliveries', column: 'notification_id' },
  { table: 'notifications', column: 'account_id' },
  { table: 'notification_preferences', column: 'account_id' },
  { table: 'devices', column: 'account_id' },
  { table: 'refresh_tokens', column: 'account_id' },
  { table: 'password_reset_tickets', column: 'account_id' },
  { table: 'idempotency_keys', column: 'account_id' },
  { table: 'account_roles', column: 'account_id' },
];

export class ErasureService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async erase(accountId: string): Promise<ErasureResult> {
    return this.db.transaction(async (tx) => {
      const account = await tx.query<{ kind: string; erased_at: Date | null }>(
        'select kind, erased_at from accounts where id = $1 for update',
        [accountId],
      );
      const row = account.rows[0];
      if (row === undefined) return { ok: false, reason: 'not-found', detail: 'no such account' };

      if (row.kind === 'staff') {
        // An officer's account is not theirs to erase. Every decision they made
        // is attributed to it, and removing it would make the permit record
        // unable to say who approved what — which is the LGU's obligation, not
        // the officer's choice. Staff offboarding is a different process.
        return {
          ok: false,
          reason: 'staff-account',
          detail: 'A staff account cannot be erased on request: it attributes decisions on permit records. '
            + 'Disable it instead, through staff offboarding.',
        };
      }

      if (row.erased_at !== null) {
        // Idempotent rather than an error. Someone asking twice is asking for
        // reassurance, and answering "already done" with the receipt is the
        // right response to that.
        return { ok: true, receipt: await this.receiptFor(tx, accountId, row.erased_at) };
      }

      const erased: Record<string, number> = {};

      // Deliveries first: they hang off notifications, which hang off the
      // account. Deleting the notifications first would orphan them.
      const deliveries = await tx.query(
        `delete from notification_deliveries
          where notification_id in (select id from notifications where account_id = $1)`,
        [accountId],
      );
      erased.notification_deliveries = deliveries.rowCount;

      for (const { table, column } of ERASE_IN_ORDER.slice(1)) {
        const result = await tx.query(`delete from ${table} where ${column} = $1`, [accountId]);
        erased[table] = result.rowCount;
      }

      const erasedAt = this.clock();

      // The row survives as an opaque key. Every personal field is cleared, the
      // account is disabled, and the verifier is replaced with a value that is
      // not a verifier — an erased account that could still be signed into is
      // not erased. Migration 011's CHECK constraint refuses this UPDATE if any
      // of it is left out.
      const cleared = await tx.query(
        `update accounts
            set email = $2,
                email_normalised = $2,
                mobile_number = null,
                totp_secret_encrypted = null,
                password_hash = 'erased',
                disabled_at = coalesce(disabled_at, $3),
                erased_at = $3,
                updated_at = $3
          where id = $1`,
        [accountId, `erased-${accountId}@erased.invalid`, erasedAt],
      );
      erased.accounts_pseudonymised = cleared.rowCount;

      // The chain records that this happened, and is itself never erased. It is
      // the evidence the LGU needs to show the request was honoured — and the
      // entry deliberately carries no personal data beyond the id that no longer
      // resolves to anything.
      await this.audit.append({
        action: 'account.erased',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        afterState: { erased },
      }, tx);

      return {
        ok: true,
        receipt: {
          acceptedAt: erasedAt.toISOString(),
          erasedCategories: ERASED_CATEGORIES,
          retainedCategories: RETAINED,
          counts: erased,
        },
      };
    });
  }

  /** The receipt for an account already erased, so a repeated request is answerable. */
  private async receiptFor(tx: SqlClient, accountId: string, erasedAt: Date): Promise<ErasureReceipt> {
    const entry = await tx.query<{ after_state: { erased: Record<string, number> } | null }>(
      `select after_state from audit_events
        where action = 'account.erased' and subject_id = $1
        order by sequence desc limit 1`,
      [accountId],
    );
    return {
      acceptedAt: erasedAt.toISOString(),
      erasedCategories: ERASED_CATEGORIES,
      retainedCategories: RETAINED,
      counts: entry.rows[0]?.after_state?.erased ?? {},
    };
  }
}

/**
 * What survives an erasure, and why.
 *
 * Returned to the data subject verbatim. RA 10173 §16(e) is conditional on
 * there being no overriding legal obligation, so naming the obligation is what
 * makes keeping the record lawful rather than merely convenient — and a person
 * is entitled to know what remains.
 */
const ERASED_CATEGORIES: readonly string[] = [
  'Your sign-in details: email address, mobile number and password',
  'Your notifications and their delivery history',
  'Your registered devices and push tokens',
  'Your active sessions, so you are signed out everywhere',
  'Any pending password-reset tickets',
];

const RETAINED: ReadonlyArray<{ category: string; basis: string; until: string | null }> = [
  {
    category: 'Your permit applications, the permits issued, and the name and address on them',
    basis: 'PD 1096 (National Building Code) and the LGU records schedule. A permit is the evidence '
      + 'that a structure was lawfully authorised, and it has to outlast your account.',
    until: null,
  },
  {
    category: 'Payments, Orders of Payment and Official Receipt numbers',
    basis: 'RA 7160 local treasury accounting and COA audit requirements.',
    until: null,
  },
  {
    category: 'The tamper-evident audit trail of actions taken on your applications',
    basis: 'NPC Circular 16-01 accountability. Each entry is hash-linked to the one before it; '
      + 'removing one would break the chain, and a broken chain cannot be told apart from a forged one. '
      + 'This includes an entry recording that your erasure request was carried out.',
    until: null,
  },
];
