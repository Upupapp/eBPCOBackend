import { StructuredLogger } from '../logging/logger';

/**
 * Stopping without dropping work on the floor.
 *
 * The version this replaces was `app.close().then(() => process.exit(0))`.
 * Three things go wrong with that, and all three are invisible until the day
 * they matter.
 *
 * **It exits before the load balancer notices.** An orchestrator sends SIGTERM
 * and removes the pod from rotation at roughly the same moment, and those are
 * two independent systems: for a second or two afterwards the balancer is still
 * routing to a process that has stopped accepting. Every one of those requests
 * is a 502 an applicant sees. So this reports **not ready first**, waits long
 * enough for the balancer to act on it, and only then stops accepting.
 *
 * **It waits forever.** A request that never finishes means `close()` never
 * resolves, the process never exits, and the orchestrator eventually SIGKILLs
 * it — mid-write, mid-transaction, with no chance to roll back. A deadline
 * turns that into a controlled exit at a moment of this process's choosing.
 *
 * **It exits 0 whatever happened.** A shutdown that failed to close the pool
 * exits claiming success, and nothing upstream ever learns.
 */

export interface ShutdownOptions {
  /**
   * How long to keep serving after reporting not-ready, so the load balancer
   * has time to stop sending. Below the balancer's own check interval this
   * achieves nothing; the default assumes a 5s interval and two failed checks.
   */
  readonly drainMs: number;
  /** How long to wait for in-flight work once no longer accepting. */
  readonly deadlineMs: number;
}

export type ShutdownOutcome = 'clean' | 'timed-out' | 'failed';

/**
 * Flipped by the shutdown sequence and read by the readiness probe.
 *
 * A signal rather than a callback so the probe stays a pure read: the thing
 * answering `/ready` should not be able to change what it is reporting on.
 */
export class DrainState {
  private draining = false;

  beginDraining(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}

export async function shutdown(options: {
  readonly drain: DrainState;
  readonly close: () => Promise<void>;
  readonly logger: StructuredLogger;
  readonly signal: string;
  readonly config: ShutdownOptions;
  /** Injected so a test does not have to wait real seconds. */
  readonly wait?: (ms: number) => Promise<void>;
}): Promise<ShutdownOutcome> {
  const { drain, close, logger, signal, config } = options;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  logger.info('shutting down', { signal, drainMs: config.drainMs, deadlineMs: config.deadlineMs });

  // Reported first, and the wait is the whole point of it. Reporting not-ready
  // and then immediately closing tells the balancer something it has no time to
  // act on.
  drain.beginDraining();
  await wait(config.drainMs);

  let timedOut = false;
  const deadline = wait(config.deadlineMs).then(() => {
    timedOut = true;
  });

  try {
    await Promise.race([close(), deadline]);
  } catch (error) {
    // An exit code that says "fine" after a failed close is how a broken
    // shutdown goes unnoticed for months.
    logger.error('shutdown failed', {
      signal,
      error: error instanceof Error ? error : { message: String(error) },
    });
    return 'failed';
  }

  if (timedOut) {
    logger.warn('shutdown deadline reached with work still in flight', {
      signal,
      deadlineMs: config.deadlineMs,
    });
    return 'timed-out';
  }

  logger.info('shutdown complete', { signal });
  return 'clean';
}

/** The exit code for an outcome. Distinct, so a crash loop can be diagnosed from logs alone. */
export function exitCodeFor(outcome: ShutdownOutcome): number {
  switch (outcome) {
    case 'clean':
      return 0;
    // Not 0: work was abandoned, and an operator tuning a deadline needs to be
    // able to tell this apart from a clean stop.
    case 'timed-out':
      return 75; // EX_TEMPFAIL
    case 'failed':
      return 70; // EX_SOFTWARE
  }
}
