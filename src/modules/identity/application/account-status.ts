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

export type AccountStanding = 'active' | 'disabled' | 'unknown';

export class AccountStatusReader {
  constructor(private readonly db: SqlClient) {}

  async standingOf(accountId: string): Promise<AccountStanding> {
    // Guarded before the query. A malformed subject in a token that somehow
    // verified should not reach the database at all.
    if (!/^[0-9a-fA-F-]{36}$/.test(accountId)) return 'unknown';

    const result = await this.db.query<{ disabled_at: Date | null }>(
      'select disabled_at from accounts where id = $1',
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return 'unknown';
    return row.disabled_at === null ? 'active' : 'disabled';
  }
}
