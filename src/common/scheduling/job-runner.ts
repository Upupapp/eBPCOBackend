import { SqlClient } from '../../persistence/sql-client';
import { StructuredLogger } from '../logging/logger';

/**
 * Runs periodic work exactly once across the fleet.
 *
 * A job is claimed before it runs, by one UPDATE whose WHERE only matches an
 * unheld lock. PostgreSQL serialises that on the row, so exactly one replica
 * gets the row back and the others get nothing and move on — no leader
 * election, no external coordinator, nothing extra to be down.
 *
 * **Every job must be safe to run twice.** The lock expires so that a replica
 * SIGKILLed mid-job does not hold it for ever, and an expiry cannot tell a dead
 * replica from a slow one. A job that overruns its lease will be started by
 * another replica while the first is still going, and the only defence is that
 * running it again is harmless. All four current jobs satisfy that: retention
 * skips what is already deleted, chain verification only reads, dispatch marks
 * each notification as it plans it, and the purge is a delete of rows already
 * past their window.
 */

export interface Job {
  readonly name: string;
  /**
   * How long this job may hold its claim. Should comfortably exceed a normal
   * run: too short and a slow run is joined by a second replica, too long and a
   * crashed replica blocks the job until it expires.
   */
  readonly leaseSeconds: number;
  /** Returns something short and non-sensitive for the record. */
  run(): Promise<string>;
}

export type RunOutcome =
  | { readonly ran: true; readonly name: string; readonly detail: string }
  | { readonly ran: false; readonly name: string; readonly reason: 'not-due' | 'held-elsewhere' | 'disabled' | 'unknown-job' }
  | { readonly ran: true; readonly name: string; readonly failed: true; readonly detail: string };

/** Kept short, and never the raw error: a failure message can carry a row from the query that failed. */
function summarise(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

export class JobRunner {
  constructor(
    private readonly db: SqlClient,
    private readonly logger: StructuredLogger,
    /** Identifies this process in the claim. A hostname or pod name in production. */
    private readonly instanceId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Claims and runs one job, or reports why it did not.
   *
   * The claim and the run are deliberately NOT in one transaction. A
   * transaction held for the length of a job holds a connection and a row lock
   * for minutes, and a job that crashes the process would leave the claim rolled
   * back and immediately re-runnable by every replica at once — which is the
   * opposite of what the lease is for.
   */
  async runIfDue(job: Job): Promise<RunOutcome> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + job.leaseSeconds * 1000);

    // One statement. The WHERE is the whole mechanism: it matches only a row
    // that is enabled, due, and either unheld or held by an expired claim.
    const claimed = await this.db.query<{ name: string }>(
      `update scheduled_jobs
          set locked_by = $2, locked_until = $3, last_started_at = $4
        where name = $1
          and enabled
          and (locked_until is null or locked_until < $4)
          and (last_started_at is null
               or last_started_at + (interval_seconds * interval '1 second') <= $4)
        returning name`,
      [job.name, this.instanceId, leaseUntil, now],
    );

    if (claimed.rows.length === 0) return { ran: false, name: job.name, reason: await this.why(job.name, now) };

    try {
      const detail = await job.run();
      await this.finish(job.name, 'succeeded', detail);
      this.logger.info('scheduled job finished', { job: job.name, outcome: 'succeeded', detail });
      return { ran: true, name: job.name, detail };
    } catch (error) {
      const detail = summarise(error);
      await this.finish(job.name, 'failed', detail);
      // Error, not warn. A job that has stopped working is an outage nobody is
      // looking at, and the whole reason it is scheduled is that no human is
      // watching it.
      this.logger.error('scheduled job failed', { job: job.name, detail });
      return { ran: true, name: job.name, failed: true, detail };
    }
  }

  /**
   * Records the outcome and releases the claim.
   *
   * Best-effort: a failure here must not mask the job's own result. The lease
   * expires on its own, so the worst case of a lost release is that the job
   * waits out its lease before running again.
   */
  private async finish(name: string, outcome: 'succeeded' | 'failed', detail: string): Promise<void> {
    try {
      await this.db.query(
        `update scheduled_jobs
            set locked_by = null, locked_until = null,
                last_finished_at = $3, last_outcome = $2, last_detail = $4,
                consecutive_failures = case when $2 = 'failed' then consecutive_failures + 1 else 0 end
          where name = $1`,
        [name, outcome, this.clock(), detail],
      );
    } catch (error) {
      this.logger.error('could not record a scheduled job outcome', {
        job: name, outcome, detail: summarise(error),
      });
    }
  }

  /** Why a claim failed, for the log. Read after the fact, so it is advisory rather than authoritative. */
  private async why(name: string, now: Date): Promise<'not-due' | 'held-elsewhere' | 'disabled' | 'unknown-job'> {
    const row = await this.db.query<{ enabled: boolean; locked_until: Date | null }>(
      'select enabled, locked_until from scheduled_jobs where name = $1',
      [name],
    );
    const found = row.rows[0];
    if (found === undefined) return 'unknown-job';
    if (!found.enabled) return 'disabled';
    if (found.locked_until !== null && found.locked_until > now) return 'held-elsewhere';
    return 'not-due';
  }

  /**
   * What an operator asks at 9am after a complaint: did it run, when, and did
   * it work.
   */
  async status(): Promise<ReadonlyArray<{
    name: string; enabled: boolean; lastFinishedAt: string | null;
    lastOutcome: string | null; consecutiveFailures: number; heldBy: string | null;
  }>> {
    const result = await this.db.query<{
      name: string; enabled: boolean; last_finished_at: Date | null;
      last_outcome: string | null; consecutive_failures: number; locked_by: string | null;
      locked_until: Date | null;
    }>(
      `select name, enabled, last_finished_at, last_outcome, consecutive_failures,
              locked_by, locked_until
         from scheduled_jobs order by name`,
    );
    const now = this.clock();
    return result.rows.map((row) => ({
      name: row.name,
      enabled: row.enabled,
      lastFinishedAt: row.last_finished_at === null ? null : new Date(row.last_finished_at).toISOString(),
      lastOutcome: row.last_outcome,
      consecutiveFailures: Number(row.consecutive_failures),
      // An expired claim is not held, whatever the column says.
      heldBy: row.locked_until !== null && new Date(row.locked_until) > now ? row.locked_by : null,
    }));
  }
}
