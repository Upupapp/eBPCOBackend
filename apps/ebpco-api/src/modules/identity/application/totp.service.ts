import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { SecretBox } from '../domain/secret-box';
import { StaffRole, requiresMfa } from '../domain/account';
import { generateSecret, provisioningUri, verify } from '../domain/totp';

/**
 * Enrolling a second factor, without being locked out by the attempt.
 *
 * ── The order that matters ──────────────────────────────────────────────
 *
 * The secret is generated, encrypted and held in a PENDING table. It moves onto
 * the account only when a code proves the authenticator app actually holds it.
 * Writing it to the account first would activate the factor the moment it was
 * created, so an officer whose app failed to scan would be locked out by the
 * act of trying to enrol — and the roles that need this most are exactly the
 * ones nobody else can unlock.
 *
 * ── Why this had to exist at all ────────────────────────────────────────
 *
 * `requiresMfa` has demanded a code from assessors, cashiers, building
 * officials, releasing officers and administrators since the role table was
 * written, and nothing could ever enrol one. `verifyTotp` fails closed with no
 * secret, so six of nine staff roles could not sign in AT ALL. Every test mints
 * its tokens directly, so nothing caught it until a client was pointed at a
 * running server.
 */

export interface EnrolmentOffer {
  /** Shown once, and never retrievable again. */
  readonly secret: string;
  /** What an authenticator app scans. */
  readonly uri: string;
  readonly expiresAt: string;
}

export type TotpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** Long enough to install an app and scan; short enough that an abandoned secret does not linger. */
const ENROLMENT_MINUTES = 15;

export class TotpService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly box: SecretBox,
    private readonly issuer: string,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async status(accountId: string): Promise<{
    enrolled: boolean; required: boolean; pending: boolean;
  }> {
    const account = await this.db.query<{ totp_secret_encrypted: string | null; kind: string }>(
      'select totp_secret_encrypted, kind from accounts where id = $1', [accountId],
    );
    const row = account.rows[0];
    const roles = await this.db.query<{ role: StaffRole }>(
      'select role from account_roles where account_id = $1', [accountId],
    );
    const pending = await this.db.query(
      'select account_id from totp_enrolments where account_id = $1 and expires_at > $2',
      [accountId, this.clock()],
    );

    return {
      enrolled: row?.totp_secret_encrypted !== null && row?.totp_secret_encrypted !== undefined,
      required: requiresMfa({
        kind: (row?.kind ?? 'applicant') as 'applicant' | 'staff',
        roles: roles.rows.map((entry) => entry.role),
      }),
      pending: pending.rows.length > 0,
    };
  }

  /** Offers a secret. Nothing is required of the account until it is activated. */
  async begin(options: { accountId: string }): Promise<TotpResult<EnrolmentOffer>> {
    const { accountId } = options;
    const now = this.clock();

    // Read here rather than taken from the caller: the access token carries no
    // address, and a label an officer supplied is one they could aim at another
    // account's entry in their app.
    const found = await this.db.query<{ email: string }>(
      'select email from accounts where id = $1', [accountId],
    );
    const email = found.rows[0]?.email;
    if (email === undefined) {
      return { ok: false, reason: 'not-found', detail: 'No such account.' };
    }

    const current = await this.status(accountId);
    if (current.enrolled) {
      // Re-enrolling silently would replace a working factor with an unproven
      // one, and an officer who abandoned the second attempt would be locked
      // out of an account that was fine before they started.
      return {
        ok: false, reason: 'already-enrolled',
        detail: 'This account already has an authenticator enrolled. An administrator must remove it first.',
      };
    }

    const secret = generateSecret();
    const expiresAt = new Date(now.getTime() + ENROLMENT_MINUTES * 60_000);

    await this.db.transaction(async (tx) => {
      // One pending enrolment. Starting again replaces the offer rather than
      // leaving two secrets either of which would activate.
      await tx.query('delete from totp_enrolments where account_id = $1', [accountId]);
      await tx.query(
        `insert into totp_enrolments (account_id, secret_encrypted, started_at, expires_at)
         values ($1,$2,$3,$4)`,
        [accountId, this.box.seal(secret), now, expiresAt],
      );
      await this.audit.append({
        action: 'mfa.enrolment-started',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: accountId,
      }, tx);
    });

    return {
      ok: true,
      value: {
        secret,
        uri: provisioningUri({ secret, account: email, issuer: this.issuer }),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /** Proves the app holds the secret, and only then makes it the account's factor. */
  async activate(options: { accountId: string; code: string }): Promise<TotpResult<{ enrolled: true }>> {
    const { accountId, code } = options;
    const now = this.clock();

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{ secret_encrypted: string; expires_at: Date }>(
        'select secret_encrypted, expires_at from totp_enrolments where account_id = $1 for update',
        [accountId],
      );
      const enrolment = found.rows[0];
      if (enrolment === undefined) {
        return {
          ok: false as const, reason: 'no-enrolment',
          detail: 'Start an enrolment first; there is no secret waiting to be confirmed.',
        };
      }
      if (enrolment.expires_at.getTime() <= now.getTime()) {
        await tx.query('delete from totp_enrolments where account_id = $1', [accountId]);
        return {
          ok: false as const, reason: 'expired',
          detail: `That enrolment has expired. Start again; they last ${ENROLMENT_MINUTES} minutes.`,
        };
      }

      const secret = this.box.open(enrolment.secret_encrypted);
      if (secret === null) {
        // Wrong key or a tampered row. Not the officer's fault and not
        // recoverable by them, so it is said plainly rather than reported as a
        // wrong code.
        return {
          ok: false as const, reason: 'unreadable',
          detail: 'The stored secret could not be read. Start the enrolment again.',
        };
      }

      const step = verify({ secret, presented: code, at: now });
      if (step === null) {
        return {
          ok: false as const, reason: 'wrong-code',
          detail: 'That code is not right. Check the app is showing a code for this account.',
        };
      }

      await tx.query(
        'update accounts set totp_secret_encrypted = $1, totp_last_step = $2 where id = $3',
        // `bytea`, not text. The column has always been bytea — "encrypted at
        // the application layer" — and passing the sealed string straight in
        // fails at the driver rather than at anything readable.
        [Buffer.from(enrolment.secret_encrypted, 'utf8'), step, accountId],
      );
      await tx.query('delete from totp_enrolments where account_id = $1', [accountId]);
      await this.audit.append({
        action: 'mfa.enrolled',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: accountId,
      }, tx);

      return { ok: true as const, value: { enrolled: true as const } };
    });
  }

  /**
   * Verifies a code at sign-in, and records the step it spent.
   *
   * The step is what stops a code being used twice inside its thirty seconds.
   * Somebody who watched an officer type one has that whole window, and without
   * this they would succeed.
   */
  async verifyAtSignIn(options: { accountId: string; code: string }): Promise<boolean> {
    // The ciphertext is read HERE, not taken from the `Account` the repository
    // returns: that mapping deliberately replaces it with '[encrypted]' so a
    // credential cannot travel through the domain type and out of a response by
    // accident. Lifting the redaction to make this convenient would undo the
    // reason it exists.
    const stored = await this.db.query<{
      totp_secret_encrypted: Uint8Array | null; totp_last_step: string | null;
    }>(
      'select totp_secret_encrypted, totp_last_step from accounts where id = $1',
      [options.accountId],
    );
    const ciphertext = stored.rows[0]?.totp_secret_encrypted;
    if (ciphertext === null || ciphertext === undefined) return false;

    // `Buffer.from` around it, not `.toString()` on it. A `bytea` comes back as
    // a Uint8Array from one driver and a Buffer from another, and calling
    // `toString('utf8')` on the former yields comma-separated byte numbers —
    // which decrypts to nothing and looks exactly like a wrong code.
    const secret = this.box.open(Buffer.from(ciphertext).toString('utf8'));
    if (secret === null) return false;

    const notBefore = stored.rows[0]?.totp_last_step;

    const step = verify({
      secret, presented: options.code, at: this.clock(),
      ...(notBefore === null || notBefore === undefined ? {} : { notBeforeStep: Number(notBefore) }),
    });
    if (step === null) return false;

    await this.db.query(
      'update accounts set totp_last_step = $1 where id = $2', [step, options.accountId],
    );
    return true;
  }
}
