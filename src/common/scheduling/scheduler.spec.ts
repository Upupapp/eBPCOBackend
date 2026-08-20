import { StructuredLogger } from '../logging/logger';
import { DrainState } from '../lifecycle/shutdown';
import { Job, JobRunner, RunOutcome } from './job-runner';
import { Scheduler } from './scheduler';

/**
 * The tick, and the two things it must not do: overlap itself, and start work
 * while the instance is shutting down.
 */

const logger = (): StructuredLogger => new StructuredLogger('error', () => undefined);

function job(name: string): Job {
  return { name, leaseSeconds: 60, run: () => Promise.resolve('ok') };
}

function fakeRunner(onRun: (name: string) => Promise<void> = () => Promise.resolve()): JobRunner {
  return {
    runIfDue: async (candidate: Job): Promise<RunOutcome> => {
      await onRun(candidate.name);
      return { ran: true, name: candidate.name, detail: 'ok' };
    },
  } as unknown as JobRunner;
}

describe('one pass', () => {
  it('offers every job to the runner', async () => {
    const seen: string[] = [];
    const scheduler = new Scheduler(
      fakeRunner((name) => { seen.push(name); return Promise.resolve(); }),
      [job('a'), job('b'), job('c')],
      logger(),
      new DrainState(),
    );

    await scheduler.tick();

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('runs them one at a time, not all at once', async () => {
    // These share a connection pool with requests an applicant is waiting on.
    // Four concurrent jobs on a pool of ten is a meaningful share of it, and
    // nothing here is urgent enough to justify that.
    let inFlight = 0;
    let peak = 0;
    const scheduler = new Scheduler(
      fakeRunner(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      }),
      [job('a'), job('b'), job('c'), job('d')],
      logger(),
      new DrainState(),
    );

    await scheduler.tick();

    expect(peak).toBe(1);
  });
});

describe('a tick that overruns', () => {
  it('is not raced by the next one', async () => {
    // A tick that takes longer than its interval should be allowed to finish.
    // Two overlapping passes would offer every job twice, and the runner's
    // exclusion is across replicas rather than within one.
    let started = 0;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const scheduler = new Scheduler(
      fakeRunner(async () => { started += 1; await blocked; }),
      [job('a')],
      logger(),
      new DrainState(),
    );

    const first = scheduler.tick();
    await Promise.resolve();
    await scheduler.tick(); // should be skipped outright
    release();
    await first;

    expect(started).toBe(1);
  });
});

describe('while shutting down', () => {
  it('starts nothing new', async () => {
    // A job begun during the drain window would still be running when the
    // deadline fires and be killed mid-way — and its lease would then hold the
    // job for its full duration on every other replica too.
    const drain = new DrainState();
    drain.beginDraining();
    const seen: string[] = [];

    await new Scheduler(
      fakeRunner((name) => { seen.push(name); return Promise.resolve(); }),
      [job('a')],
      logger(),
      drain,
    ).tick();

    expect(seen).toEqual([]);
  });

  it('stops part-way through a pass rather than finishing it', async () => {
    const drain = new DrainState();
    const seen: string[] = [];

    await new Scheduler(
      fakeRunner((name) => {
        seen.push(name);
        drain.beginDraining();
        return Promise.resolve();
      }),
      [job('a'), job('b'), job('c')],
      logger(),
      drain,
    ).tick();

    expect(seen).toEqual(['a']);
  });
});

describe('the timer', () => {
  it('does not keep the process alive on its own', () => {
    // A service that will not exit because a timer is armed looks like a hung
    // shutdown, and an orchestrator resolves that with SIGKILL.
    const scheduler = new Scheduler(fakeRunner(), [job('a')], logger(), new DrainState(), 3600);

    scheduler.start();
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    scheduler.stop();

    // `unref`'d timers are not reported as handles keeping the loop alive.
    expect(handles.filter((h) => h?.constructor?.name === 'Timeout')).toHaveLength(0);
  });

  it('starting twice arms one interval, so stop actually stops', async () => {
    // `stop()` only clears the handle it remembers. A second `start()` that
    // armed a second interval would leave one running for ever, and the leak is
    // silent — which is why the assertion is about what happens AFTER stop.
    //
    // The first version of this test asserted on ticks BEFORE stop and passed
    // with the guard removed, because the re-entrancy check was swallowing the
    // duplicate. It was measuring the wrong thing.
    jest.useFakeTimers();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    try {
      const seen: string[] = [];
      const scheduler = new Scheduler(
        fakeRunner((name) => { seen.push(name); return Promise.resolve(); }),
        [job('a')], logger(), new DrainState(), 1,
      );

      scheduler.start();
      scheduler.start();
      scheduler.stop();

      for (let tick = 0; tick < 10; tick += 1) {
        jest.advanceTimersByTime(1_000);
        await flush();
      }

      expect(seen).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
