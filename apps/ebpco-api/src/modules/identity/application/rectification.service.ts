import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';

/**
 * The RA 10173 §16(d) right to have inaccurate personal data corrected.
 *
 * Not a settings screen. §16(d) is a statutory right, which is why the change
 * is audited and why a refusal has to say what is wrong rather than ignoring
 * the field it could not apply.
 *
 * ── What is rectifiable here, and what is not ─────────────────────────────
 *
 * NAME and MOBILE NUMBER. Both are things a citizen can simply have wrong on
 * the record, and neither authenticates anybody.
 *
 * EMAIL IS NOT, and its absence is deliberate. It is the sign-in identity: a
 * change is not a correction but a transfer of who can reach the account, and
 * doing it without proving the new address first would turn a rectification
 * route into account takeover. It needs the same request/confirm shape the
 * contact channels already have, which is a separate piece of work.
 *
 * A STAFF MEMBER'S NAME is not rectifiable here either. It is set by the office
 * on their access request and appears against their acts in the audit trail;
 * correcting it is an administrator's job, not self-service.
 */
export type RectificationResult =
  | { readonly ok: true; readonly mobileVerificationCleared: boolean }
  | { readonly ok: false; readonly reason: 'no-profile'; readonly detail: string };

export class RectificationService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async rectify(options: {
    accountId: string;
    // `| undefined` explicitly, not just optional: `exactOptionalPropertyTypes`
    // is on, and the caller spreads a parsed body whose absent fields are
    // present-and-undefined. Declaring what actually arrives beats making the
    // controller construct an object to satisfy a narrower signature.
    firstName?: string | undefined;
    lastName?: string | undefined;
    mobileNumber?: string | undefined;
  }): Promise<RectificationResult> {
    const { accountId } = options;

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{
        first_name: string; last_name: string; mobile_number: string | null;
      }>(
        `select ap.first_name, ap.last_name, acc.mobile_number
           from applicants ap
           join accounts acc on acc.id = ap.account_id
          where ap.account_id = $1
          for update`,
        [accountId],
      );
      const before = existing.rows[0];
      if (before === undefined) {
        // Staff have no applicants row. Saying so plainly beats a silent
        // success that changes nothing.
        return {
          ok: false as const, reason: 'no-profile' as const,
          detail: 'This account has no applicant profile to correct.',
        };
      }

      const firstName = options.firstName ?? before.first_name;
      const lastName = options.lastName ?? before.last_name;
      const now = this.clock();

      if (firstName !== before.first_name || lastName !== before.last_name) {
        await tx.query(
          'update applicants set first_name = $1, last_name = $2, updated_at = $3 where account_id = $4',
          [firstName, lastName, now, accountId],
        );
      }

      // ── Changing the number un-verifies it ────────────────────────────────
      //
      // The verification belonged to the OLD number: a code was sent there and
      // answered from there. Carrying `mobile_verified_at` across to a new
      // number would assert that somebody proved control of a number nobody
      // ever sent anything to — and since the mobile channel is the second
      // factor for contact, that is a verified flag standing over an unproven
      // destination.
      //
      // Pending challenges go too. One outstanding against the old number
      // would otherwise be confirmable afterwards and would verify the NEW one.
      const changingNumber = options.mobileNumber !== undefined
        && options.mobileNumber !== before.mobile_number;

      if (changingNumber) {
        await tx.query(
          `update accounts set mobile_number = $1, mobile_verified_at = null, updated_at = $2
            where id = $3`,
          [options.mobileNumber, now, accountId],
        );
        await tx.query(
          `delete from contact_verification_challenges
            where account_id = $1 and channel = 'mobile'`,
          [accountId],
        );
      }

      // Audited because §16(d) is a right, and a controller has to be able to
      // evidence that it honoured one. The values are NOT in the entry: an
      // audit row naming the old and new number would re-create the personal
      // data the citizen just corrected, in a table that is deliberately
      // append-only and cannot be edited afterwards.
      // ON `tx`, not on the pool. Two reasons, and both bite.
      //
      // Correctness: an entry written outside this transaction survives a
      // rollback, claiming a correction that never happened -- the same rule
      // `remember()` states for idempotency keys.
      //
      // And it deadlocks. `append` defaults to `this.db`, which takes a SECOND
      // connection while this transaction holds one; against PGlite, which
      // serves a single connection, the request simply hangs until the test
      // times out. It looks like a slow query and is a self-inflicted wait.
      await this.audit.append({
        action: 'profile.rectified',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: accountId,
      }, tx);

      return { ok: true as const, mobileVerificationCleared: changingNumber };
    });
  }
}
