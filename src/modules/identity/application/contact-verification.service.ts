import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';

/**
 * Proving that an address or a number reaches the applicant.
 *
 * ── The half this cannot do ─────────────────────────────────────────────
 *
 * SENDING. There is no email or SMS provider (E-1, M-27): the notification
 * pipeline plans and queues and nothing has ever gone out. So a challenge is
 * issued, recorded and queued for delivery, and the applicant never receives
 * it. Every refusal below is real; the success path cannot be reached by a
 * human until a provider exists.
 *
 * That is stated rather than hidden because the app it serves refused to
 * fabricate the same tick from the other side: a code the client generated and
 * then checked against itself would verify nothing except that the applicant
 * can read their own screen. The same is true of a server that accepts any
 * code, so this one does not.
 *
 * ── What makes the code a secret ────────────────────────────────────────
 *
 * A digest, never the code — anyone who could read the table could otherwise
 * verify any channel in it, and a backup would carry live credentials. A
 * constant-time comparison, because `!==` on a secret leaks through timing how
 * many leading characters were right. An attempt limit, because six digits is a
 * million guesses and a million guesses is nothing to a machine. And an expiry,
 * because a code that works forever is a password nobody chose.
 */

export type Channel = 'email' | 'mobile';

export type VerificationStatus =
  | 'Unverified' | 'Pending Verification' | 'Verified' | 'Verification Failed';

export interface ContactState {
  readonly channel: Channel;
  /** The address or number as the applicant gave it; empty when they gave none. */
  readonly value: string;
  readonly status: VerificationStatus;
  readonly method: string | null;
  readonly verifiedAt: string | null;
  readonly lastRequestedAt: string | null;
}

export type VerificationResult =
  | { readonly ok: true; readonly state: ContactState }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** The method an applicant can drive themselves, per channel. */
const METHOD_OF: Readonly<Record<Channel, string>> = {
  email: 'Email Verification Link',
  mobile: 'Mobile OTP',
};

/** Long enough to fetch a message, short enough that a stolen code is stale. */
const TTL_MINUTES = 15;
/** After this many wrong codes the challenge is spent, not merely refused. */
const MAX_ATTEMPTS = 5;
/** A new code cannot be asked for faster than this. */
const RESEND_SECONDS = 60;

export class ContactVerificationService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * `tx` is not optional decoration. Called from inside an open transaction on
   * the outer client, this blocks until the request times out — PGlite is a
   * single connection. That deadlock has now cost three separate investigations
   * in this codebase, each presenting as a slow endpoint rather than a hang, so
   * the reader is stated in the signature instead of assumed.
   */
  async statesFor(accountId: string, tx: SqlClient = this.db): Promise<readonly ContactState[]> {
    const account = await tx.query<{ email: string; mobile_number: string | null }>(
      'select email, mobile_number from accounts where id = $1', [accountId],
    );
    const row = account.rows[0];
    if (row === undefined) return [];

    const stored = await tx.query<{
      channel: Channel; status: VerificationStatus; method: string | null;
      verified_at: Date | null; last_requested_at: Date | null;
    }>(
      `select channel, status, method, verified_at, last_requested_at
         from contact_verifications where account_id = $1`,
      [accountId],
    );
    const byChannel = new Map(stored.rows.map((entry) => [entry.channel, entry]));

    // Both channels always, even where nothing has been recorded. "Nothing to
    // verify" is its own state and the applicant is entitled to see it: an
    // absent row would read to a client as a missing channel rather than an
    // unverified one.
    return (['email', 'mobile'] as const).map((channel) => {
      const entry = byChannel.get(channel);
      return {
        channel,
        value: channel === 'email' ? row.email : row.mobile_number ?? '',
        status: entry?.status ?? 'Unverified',
        method: entry?.method ?? null,
        verifiedAt: entry?.verified_at?.toISOString() ?? null,
        lastRequestedAt: entry?.last_requested_at?.toISOString() ?? null,
      };
    });
  }

  /**
   * Issues a challenge and queues the notice carrying it.
   *
   * Returns the code to the CALLER, not to the applicant — the transport
   * discards it. It exists on this boundary so that a delivery adapter, when
   * one is built, has something to send; today nothing consumes it, which is
   * exactly what "no provider" means.
   */
  async request(options: { accountId: string; channel: Channel }): Promise<
    VerificationResult & { code?: string }
  > {
    const { accountId, channel } = options;
    const now = this.clock();

    const states = await this.statesFor(accountId);
    const state = states.find((entry) => entry.channel === channel);
    if (state === undefined) {
      return { ok: false, reason: 'not-found', detail: 'No such account.' };
    }
    if (state.value.trim() === '') {
      // Nothing to verify is not the same as unverified, and sending a code to
      // an empty address would fail somewhere the applicant cannot see.
      return {
        ok: false, reason: 'no-value',
        detail: channel === 'email'
          ? 'This account has no email address to verify.'
          : 'Add a mobile number before asking for a code.',
      };
    }
    if (state.status === 'Verified') {
      return { ok: false, reason: 'already-verified', detail: 'This channel is already verified.' };
    }

    const live = await this.db.query<{ issued_at: Date }>(
      `select issued_at from contact_verification_challenges
        where account_id = $1 and channel = $2 and consumed_at is null`,
      [accountId, channel],
    );
    const issuedAt = live.rows[0]?.issued_at;
    if (issuedAt !== undefined && now.getTime() - issuedAt.getTime() < RESEND_SECONDS * 1000) {
      // Not merely politeness: each SMS costs the LGU money, and a resend
      // button with no floor is a way to spend it.
      return {
        ok: false, reason: 'too-soon',
        detail: `A code was just sent. Wait ${RESEND_SECONDS} seconds before asking for another.`,
      };
    }

    // Six digits, from a cryptographic source. `Math.random()` is predictable
    // from a few observations, which for a code that authorises something is
    // the difference between a secret and a formality.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    await this.db.transaction(async (tx) => {
      // The previous challenge is spent, not left beside the new one: two live
      // codes means the applicant cannot tell which to type and an attacker
      // gets two guesses per request.
      await tx.query(
        `update contact_verification_challenges set consumed_at = $1
          where account_id = $2 and channel = $3 and consumed_at is null`,
        [now, accountId, channel],
      );
      await tx.query(
        `insert into contact_verification_challenges (account_id, channel, code_digest, issued_at, expires_at)
         values ($1,$2,$3,$4,$5)`,
        [accountId, channel, digestOf(code), now, new Date(now.getTime() + TTL_MINUTES * 60_000)],
      );
      await tx.query(
        `insert into contact_verifications (account_id, channel, status, last_requested_at)
         values ($1,$2,'Pending Verification',$3)
         on conflict (account_id, channel) do update
           set status = 'Pending Verification', last_requested_at = excluded.last_requested_at`,
        [accountId, channel, now],
      );
      await this.audit.append({
        action: 'contact.verification-requested',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: accountId,
        afterState: { channel, method: METHOD_OF[channel] },
      }, tx);
    });

    const updated = await this.statesFor(accountId);
    return { ok: true, state: updated.find((entry) => entry.channel === channel)!, code };
  }

  async confirm(options: {
    accountId: string; channel: Channel; code: string;
  }): Promise<VerificationResult> {
    const { accountId, channel, code } = options;
    const now = this.clock();

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{
        id: string; code_digest: string; expires_at: Date; attempts: number;
      }>(
        `select id, code_digest, expires_at, attempts
           from contact_verification_challenges
          where account_id = $1 and channel = $2 and consumed_at is null
          for update`,
        [accountId, channel],
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
          'update contact_verification_challenges set consumed_at = $1 where id = $2',
          [now, challenge.id],
        );
        return {
          ok: false, reason: 'expired',
          detail: `That code has expired. Ask for another; they last ${TTL_MINUTES} minutes.`,
        };
      }

      if (!matches(challenge.code_digest, code)) {
        const attempts = challenge.attempts + 1;
        const spent = attempts >= MAX_ATTEMPTS;
        await tx.query(
          `update contact_verification_challenges set attempts = $1, consumed_at = $2 where id = $3`,
          [attempts, spent ? now : null, challenge.id],
        );
        if (spent) {
          // Failed, not merely unverified: somebody tried and it did not work,
          // and the applicant is owed the difference.
          await tx.query(
            `update contact_verifications set status = 'Verification Failed'
              where account_id = $1 and channel = $2`,
            [accountId, channel],
          );
          await this.audit.append({
            action: 'contact.verification-failed',
            subjectType: 'account',
            subjectId: accountId,
            outcome: 'denied',
            actorAccountId: accountId,
            afterState: { channel, attempts },
          }, tx);
        }
        return {
          ok: false, reason: spent ? 'too-many-attempts' : 'wrong-code',
          detail: spent
            ? 'Too many wrong codes. Ask for a new one.'
            : 'That code is not right.',
        };
      }

      await tx.query(
        'update contact_verification_challenges set consumed_at = $1 where id = $2',
        [now, challenge.id],
      );
      await tx.query(
        `update contact_verifications set status = 'Verified', method = $1, verified_at = $2
          where account_id = $3 and channel = $4`,
        [METHOD_OF[channel], now, accountId, channel],
      );
      // The account's own column too. It has existed since the first migration
      // and nothing ever set it; the guard and the export both read it.
      await tx.query(
        channel === 'email'
          ? 'update accounts set email_verified_at = $1 where id = $2'
          : 'update accounts set mobile_verified_at = $1 where id = $2',
        [now, accountId],
      );
      await this.audit.append({
        action: 'contact.verified',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: accountId,
        afterState: { channel, method: METHOD_OF[channel] },
      }, tx);

      const states = await this.statesFor(accountId, tx);
      return { ok: true, state: states.find((entry) => entry.channel === channel)! };
    });
  }
}

function digestOf(code: string): string {
  // SHA-256 rather than scrypt, deliberately and with a reason: this secret
  // lives for fifteen minutes, is six digits from a cryptographic source, and
  // is rate-limited to five guesses. A slow hash defends against an offline
  // attack on a stolen table; the defence here is the short life and the
  // attempt count, and a per-request scrypt would cost the LGU real latency for
  // no gain against the attack that matters.
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function matches(storedDigest: string, presented: string): boolean {
  const expected = Buffer.from(storedDigest, 'utf8');
  const candidate = Buffer.from(digestOf(presented), 'utf8');
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}
