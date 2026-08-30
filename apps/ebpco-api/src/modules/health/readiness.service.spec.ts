import { DependencyName, DependencyState, ReadinessService } from './readiness.service';

const probe = (
  name: DependencyName,
  state: DependencyState,
  critical: boolean,
  detail?: string,
) => ({
  name,
  critical,
  check: () => Promise.resolve(detail === undefined ? { state } : { state, detail }),
});

describe('readiness', () => {
  it('reports ready with no checks when nothing has been wired yet', async () => {
    // TAB 02 stands up the service with no backing service. The honest answer
    // is that this instance genuinely depends on nothing yet -- not four
    // probes reporting `up` against services that do not exist, which would
    // make the first real outage invisible.
    const report = await new ReadinessService().report();

    expect(report).toEqual({ status: 'ready', checks: [] });
  });

  it('reports ready when every registered dependency is up', async () => {
    const readiness = new ReadinessService();
    readiness.register(probe('database', 'up', true));
    readiness.register(probe('objectStore', 'up', true));

    expect((await readiness.report()).status).toBe('ready');
  });

  it('is degraded, not unavailable, when a non-critical dependency is down', async () => {
    // Taking the instance out of rotation because the scanner is down would
    // turn a partial outage into a total one: uploads are held unscanned and
    // every other route still works.
    const readiness = new ReadinessService();
    readiness.register(probe('database', 'up', true));
    readiness.register(probe('malwareScanner', 'down', false, 'scanner unreachable'));

    const report = await readiness.report();

    expect(report.status).toBe('degraded');
    expect(report.checks).toContainEqual({
      name: 'malwareScanner',
      status: 'down',
      detail: 'scanner unreachable',
    });
  });

  it('is unavailable when a critical dependency is down', async () => {
    const readiness = new ReadinessService();
    readiness.register(probe('database', 'down', true, 'connection refused'));
    readiness.register(probe('malwareScanner', 'up', false));

    expect((await readiness.report()).status).toBe('unavailable');
  });

  it('treats a probe that throws as a dependency that is down', async () => {
    // Never let a failing check read as a passing one.
    const readiness = new ReadinessService();
    readiness.register({
      name: 'database',
      critical: true,
      check: () => Promise.reject(new Error('ETIMEDOUT')),
    });

    const report = await readiness.report();

    expect(report.status).toBe('unavailable');
    expect(report.checks[0]).toEqual({ name: 'database', status: 'down', detail: 'ETIMEDOUT' });
  });

  it('reports a null detail rather than omitting the key', async () => {
    // The contract types detail as nullable, not optional.
    const readiness = new ReadinessService();
    readiness.register(probe('database', 'up', true));

    expect((await readiness.report()).checks[0]).toEqual({ name: 'database', status: 'up', detail: null });
  });

  it('registers one probe per dependency name', async () => {
    const readiness = new ReadinessService();
    readiness.register(probe('database', 'down', true));
    readiness.register(probe('database', 'up', true));

    expect(readiness.registered()).toEqual(['database']);
    expect((await readiness.report()).status).toBe('ready');
  });

  it('checks dependencies concurrently rather than one after another', async () => {
    const slow = (name: DependencyName) => ({
      name,
      critical: false,
      check: () => new Promise<{ state: DependencyState }>((resolve) =>
        setTimeout(() => resolve({ state: 'up' as const }), 60),
      ),
    });
    const readiness = new ReadinessService();
    readiness.register(slow('database'));
    readiness.register(slow('objectStore'));
    readiness.register(slow('malwareScanner'));

    const started = Date.now();
    await readiness.report();

    // Three 60ms probes in series would be 180ms. A readiness probe that takes
    // longer than its own timeout gets the instance killed.
    expect(Date.now() - started).toBeLessThan(150);
  });
});
