import { SqlClient } from '../../../persistence/sql-client';

/**
 * Whether the account behind a token is still allowed to act.
 *
 * The guard verified a signature and nothing else. `disabled_at` was checked at
 * sign-in and at refresh, so an account disabled a moment after either kept
 * full access until its access token expired — up to fifteen minutes. That
 * window covers a staff member who has just been offboarded, an account
 * suspended for suspected fraud, and one that has just exercised erasure. "We
 * have disabled them" was a statement this system did not honour for a quarter
 * of an hour.
 *
 * It also cost one query to fix the older defect beside it: a token whose
 * account had been deleted outright verified fine, was let through, and then
 * hit a foreign key on the first write that referenced it — producing a 500 on
 * a write and a 200 on a read, which is an existence oracle wearing a server
 * error.
 *
 * **This adds one indexed primary-key lookup to every authenticated request.**
 * That is a real cost and it is the right one: an authorisation decision made
 * from a fifteen-minute-old snapshot is not an authorisation decision. The
 * public routes — the health and readiness probes — skip the guard entirely, so
 * nothing an orchestrator polls pays for it.
 *
 * A short-lived cache would cut the cost and reintroduce exactly the staleness
 * this removes. Deliberately not added: there is no load test yet, so it would
 * be trading a known correctness property for an unmeasured saving.
 */

export type AccountStanding = 'active' | 'disabled' | 'unknown' | 'session-revoked';

const UUID = /^[0-9a-fA-F-]{36}$/;

export class AccountStatusReader {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * One round trip for both questions.
   *
   * The account and the session are separate concerns and separate answers, and
   * asking them in two queries would double the per-request cost for no benefit
   * — nothing acts on the first answer before the second is needed.
   *
   * An UNKNOWN session is allowed through, deliberately. The revocation table
   * records sessions that HAVE been signed out; it is not a register of every
   * session that exists. Treating an unrecorded family as revoked would mean
   * inferring liveness from the absence of a row, which is the coupling this
   * design exists to avoid — and the account check above is what actually
   * carries the authority, since a family id grants nothing on its own.
   */
  async standingOf(accountId: string, sessionId?: string): Promise<AccountStanding> {
    // Guarded before the query. A malformed subject in a token that somehow
    // verified should not reach the database at all.
    if (!UUID.test(accountId)) return 'unknown';
    const session = sessionId !== undefined && UUID.test(sessionId) ? sessionId : null;

    const result = await this.db.query<{ disabled_at: Date | null; session_revoked: boolean }>(
      `select a.disabled_at,
              coalesce((
                select r.expires_at > $3 from revoked_sessions r where r.family_id = $2
              ), false) as session_revoked
         from accounts a
        where a.id = $1`,
      [accountId, session, this.clock()],
    );

    const row = result.rows[0];
    if (row === undefined) return 'unknown';
    if (row.disabled_at !== null) return 'disabled';
    // Checked after the account, so a disabled account reads as disabled rather
    // than as a revoked session — the more useful of the two messages.
    if (row.session_revoked) return 'session-revoked';
    return 'active';
  }
}
