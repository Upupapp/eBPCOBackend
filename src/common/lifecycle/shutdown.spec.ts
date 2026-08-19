import { StructuredLogger } from '../logging/logger';
import { DrainState, exitCodeFor, shutdown } from './shutdown';

/**
 * Stopping without dropping work.
 *
 * Every assertion here is about a failure that is invisible until the day it
 * matters, which is why the sequence is a testable function rather than four
 * lines in `main.ts`.
 */

function logger(): { logger: StructuredLogger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new StructuredLogger('info', (line) => lines.push(line)), lines };
}

/** Records the order of waits without spending real time on them. */
function fakeClock(): { wait: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return {
    waited,
    wait: (ms: number) => {
      waited.push(ms);
      // Resolves on a later microtask, so anything racing it still gets to run.
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

describe('the order of operations', () => {
  it('reports NOT READY before it stops accepting', async () => {
    // An orchestrator removes the pod from rotation and sends SIGTERM at
    // roughly the same moment, and those are two independent systems. For a
    // second or two the balancer is still routing to a process that has
    // stopped accepting, and every one of those requests is a 502 an applicant
    // sees.
    const drain = new DrainState();
    const order: string[] = [];
    const clock = fakeClock();

    await shutdown({
      drain,
      close: () => {
        order.push('closed');
        return Promise.resolve();
      },
      logger: logger().logger,
      signal: 'SIGTERM',
      config: { drainMs: 12_000, deadlineMs: 20_000 },
      wait: (ms) => {
        order.push(`waited:${ms}`);
        return clock.wait(ms);
      },
    });

    expect(drain.isDraining).toBe(true);
    expect(order[0]).toBe('waited:12000');
    expect(order).toContain('closed');
    expect(order.indexOf('waited:12000')).toBeLessThan(order.indexOf('closed'));
  });

  it('waits the configured drain period, not zero', async () => {
    // Reporting not-ready and immediately closing tells the balancer something
    // it has no time to act on.
    const clock = fakeClock();

    await shutdown({
      drain: new DrainState(),
      close: () => Promise.resolve(),
      logger: logger().logger,
      signal: 'SIGTERM',
      config: { drainMs: 12_000, deadlineMs: 20_000 },
      wait: clock.wait,
    });

    expect(clock.waited[0]).toBe(12_000);
  });
});

describe('the deadline', () => {
  it('gives up rather than hanging forever on a stuck request', async () => {
    // Without it the process never exits and the orchestrator SIGKILLs it —
    // mid-write, mid-transaction, with no chance to roll back.
    const outcome = await shutdown({
      drain: new DrainState(),
      close: () => new Promise<void>(() => undefined), // never resolves
      logger: logger().logger,
      signal: 'SIGTERM',
      config: { drainMs: 0, deadlineMs: 1 },
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });

    expect(outcome).toBe('timed-out');
  });

  it('exits non-zero when it fires, so a tuned deadline can be told from a clean stop', () => {
    expect(exitCodeFor('timed-out')).not.toBe(0);
  });

  it('says what it abandoned', async () => {
    const { logger: log, lines } = logger();

    await shutdown({
      drain: new DrainState(),
      close: () => new Promise<void>(() => undefined),
      logger: log,
      signal: 'SIGTERM',
      config: { drainMs: 0, deadlineMs: 1 },
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });

    expect(lines.join('\n')).toContain('still in flight');
  });
});

describe('when closing fails', () => {
  it('reports failure rather than exiting 0', async () => {
    // A shutdown that failed to close the pool exiting with success is how a
    // broken shutdown goes unnoticed for months.
    const outcome = await shutdown({
      drain: new DrainState(),
      close: () => Promise.reject(new Error('pool did not end')),
      logger: logger().logger,
      signal: 'SIGTERM',
      config: { drainMs: 0, deadlineMs: 5_000 },
      wait: fakeClock().wait,
    });

    expect(outcome).toBe('failed');
    expect(exitCodeFor(outcome)).not.toBe(0);
  });

  it('logs the reason', async () => {
    const { logger: log, lines } = logger();

    await shutdown({
      drain: new DrainState(),
      close: () => Promise.reject(new Error('pool did not end')),
      logger: log,
      signal: 'SIGTERM',
      config: { drainMs: 0, deadlineMs: 5_000 },
      wait: fakeClock().wait,
    });

    expect(lines.join('\n')).toContain('pool did not end');
  });
});

describe('a clean stop', () => {
  it('exits 0', async () => {
    const outcome = await shutdown({
      drain: new DrainState(),
      close: () => Promise.resolve(),
      logger: logger().logger,
      signal: 'SIGTERM',
      config: { drainMs: 0, deadlineMs: 5_000 },
      wait: fakeClock().wait,
    });

    expect(outcome).toBe('clean');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('gives each outcome its own exit code, so logs alone diagnose a crash loop', () => {
    const codes = ['clean', 'timed-out', 'failed'].map((outcome) =>
      exitCodeFor(outcome as 'clean' | 'timed-out' | 'failed'));

    expect(new Set(codes).size).toBe(3);
  });
});
