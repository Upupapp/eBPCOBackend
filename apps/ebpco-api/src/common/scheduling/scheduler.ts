import { Job, JobRunner } from './job-runner';
import { StructuredLogger } from '../logging/logger';
import { DrainState } from '../lifecycle/shutdown';

/**
 * The tick.
 *
 * Deliberately simple: every `tickSeconds`, offer each job to the runner, which
 * decides whether it is due and whether this replica may take it. The schedule
 * lives in the database, not here, so changing how often retention runs is an
 * UPDATE rather than a deploy.
 *
 * The tick is short relative to the shortest job interval — a job due every 60
 * seconds will not run on time if nothing looks more often than that — and it
 * costs one small UPDATE per job per tick, which is the price of not needing a
 * coordinator.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly runner: JobRunner,
    private readonly jobs: readonly Job[],
    private readonly logger: StructuredLogger,
    private readonly drain: DrainState,
    private readonly tickSeconds = 15,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // `unref` so a pending tick never keeps the process alive on its own. A
    // service that will not exit because a timer is armed looks like a hung
    // shutdown, and an orchestrator resolves that with SIGKILL.
    this.timer = setInterval(() => void this.tick(), this.tickSeconds * 1000);
    this.timer.unref();
    this.logger.info('scheduler started', {
      tickSeconds: this.tickSeconds,
      jobs: this.jobs.map((job) => job.name),
    });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every job.
   *
   * Sequential, not parallel. These are background jobs sharing a connection
   * pool with requests an applicant is waiting on, and four concurrent jobs on
   * a pool of ten is a meaningful share of it. Nothing here is urgent enough to
   * justify that.
   *
   * Re-entrant calls are skipped rather than queued: a tick that overruns its
   * interval should be allowed to finish, not raced by the next one.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    // Nothing new is started once the instance is shutting down. A job begun
    // during the drain window would still be running when the deadline fires
    // and be killed mid-way — and its lease would then hold the job for its
    // full duration on every other replica too.
    if (this.drain.isDraining) return;

    this.running = true;
    try {
      for (const job of this.jobs) {
        if (this.drain.isDraining) return;
        await this.runner.runIfDue(job);
      }
    } finally {
      this.running = false;
    }
  }
}
