import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';

/**
 * Proving an email reaches its owner BEFORE an account exists for it.
 *
 * The account-scoped `ContactVerificationService` (migration 025) cannot do
 * this: it needs an `account_id`, and there is none yet at the point in the
 * registration wizard this serves — the citizen has typed an email on Step
 * 2 of 3 and nothing else. This is that same discipline (a peppered HMAC
 * digest, never the code itself; a constant-time comparison; a short
 * expiry; a bounded attempt count; one live challenge at a time) applied to
 * an email address instead of an account.
 *
 * `request`/`confirm` mirror that service's own shape closely on purpose —
 * two readers of the same table would drift the way `staff-queue.service.ts`
 * once did before it was collapsed to one; here there was never a second
 * table, so the parallel is kept only in shape, not in a shared reader.
 */

const TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
/** How long a CONFIRMED-but-not-yet-consumed proof stays good for finishing registration — long enough to fill in Steps 2-3, short enough that an abandoned signup cannot be resumed as a standing credential days later. */
const CONFIRMED_PROOF_TTL_MINUTES = 30;

export type RequestResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: 'too-soon'; readonly detail: string };

export type ConfirmResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'no-challenge' | 'expired' | 'wrong-code' | 'too-many-attempts';
      readonly detail: string;
    };

export class RegistrationVerificationService {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly pepper: string = '',
  ) {}

  private normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  async request(email: string): Promise<RequestResult> {
    const normalised = this.normalise(email);
    const now = this.clock();

    const live = await this.db.query<{ issued_at: Date }>(
      `select issued_at from registration_email_challenges
        where email = $1 and confirmed_at is null and consumed_at is null`,
      [normalised],
    );
    const issuedAt = live.rows[0]?.issued_at;
    if (issuedAt !== undefined && now.getTime() - issuedAt.getTime() < RESEND_SECONDS * 1000) {
      return {
        ok: false, reason: 'too-soon',
        detail: `A code was just sent. Wait ${RESEND_SECONDS} seconds before asking for another.`,
      };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.transaction(async (tx) => {
      // The previous live challenge is spent, not left beside the new one —
      // same reasoning as contact-verification.service.ts's own request().
      await tx.query(
        `update registration_email_challenges set consumed_at = $1
          where email = $2 and confirmed_at is null and consumed_at is null`,
        [now, normalised],
      );
      await tx.query(
        `insert into registration_email_challenges (email, code_digest, issued_at, expires_at)
         values ($1,$2,$3,$4)`,
        [normalised, this.digestOf(code), now, new Date(now.getTime() + TTL_MINUTES * 60_000)],
      );
    });

    return { ok: true, code };
  }

  async confirm(email: string, code: string): Promise<ConfirmResult> {
    const normalised = this.normalise(email);
    const now = this.clock();

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{
        id: string; code_digest: string; expires_at: Date; attempts: number;
      }>(
        `select id, code_digest, expires_at, attempts
           from registration_email_challenges
          where email = $1 and confirmed_at is null and consumed_at is null
          for update`,
        [normalised],
      );
      const challenge = found.rows[0];
      if (challenge === undefined) {
        return {
          ok: false, reason: 'no-challenge',
          detail: 'Ask for a code first; there is nothing outstanding to confirm.',
        };
      }
      if (challenge.expires_at.getTime() <= now.getTime()) {
        await tx.query(
          'update registration_email_challenges set consumed_at = $1 where id = $2',
          [now, challenge.id],
        );
        return {
          ok: false, reason: 'expired',
          detail: `That code has expired. Ask for another; they last ${TTL_MINUTES} minutes.`,
        };
      }

      if (!this.matches(challenge.code_digest, code)) {
        const attempts = challenge.attempts + 1;
        const spent = attempts >= MAX_ATTEMPTS;
        await tx.query(
          `update registration_email_challenges set attempts = $1, consumed_at = $2 where id = $3`,
          [attempts, spent ? now : null, challenge.id],
        );
        return {
          ok: false, reason: spent ? 'too-many-attempts' : 'wrong-code',
          detail: spent
            ? 'Too many wrong codes. Ask for a new one.'
            : 'That code is not right.',
        };
      }

      await tx.query(
        'update registration_email_challenges set confirmed_at = $1 where id = $2',
        [now, challenge.id],
      );
      return { ok: true };
    });
  }

  /**
   * Spends a confirmed proof for this email, if one exists and is still
   * within its window — called once, from inside `register()`'s own
   * transaction, at the moment an account is actually about to be created.
   * `true` means `register()` may mark the new account's email verified
   * immediately; `false` means it must not (nothing was confirmed, it
   * already expired, or — a replay — it was already spent by an earlier
   * registration attempt for the same address).
   */
  async consumeConfirmedProof(email: string, tx: SqlClient = this.db): Promise<boolean> {
    const normalised = this.normalise(email);
    const now = this.clock();
    const notBefore = new Date(now.getTime() - CONFIRMED_PROOF_TTL_MINUTES * 60_000);
    const result = await tx.query<{ id: string }>(
      `update registration_email_challenges
          set consumed_at = $2
        where email = $1 and confirmed_at is not null and consumed_at is null
          and confirmed_at > $3
        returning id`,
      [normalised, now, notBefore],
    );
    return result.rows.length > 0;
  }

  private digestOf(code: string): string {
    return createHmac('sha256', this.pepper).update(code, 'utf8').digest('hex');
  }

  private matches(storedDigest: string, presented: string): boolean {
    const expected = Buffer.from(storedDigest, 'utf8');
    const candidate = Buffer.from(this.digestOf(presented), 'utf8');
    if (expected.length !== candidate.length) return false;
    return timingSafeEqual(expected, candidate);
  }
}
