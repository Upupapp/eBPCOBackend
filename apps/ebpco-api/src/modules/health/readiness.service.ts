import { Injectable } from '@nestjs/common';

/**
 * The names the contract permits for a readiness check. Closed, because
 * `/ready` is consumed by a load balancer and a monitor, and an unrecognised
 * name is a check nobody has a runbook for.
 */
export type DependencyName = 'database' | 'objectStore' | 'malwareScanner' | 'pushProvider';

export type DependencyState = 'up' | 'down';

export interface DependencyProbe {
  readonly name: DependencyName;
  /**
   * Whether the service can serve any useful traffic without this dependency.
   *
   * The database is critical: without it every route fails, so the instance
   * should be taken out of rotation. The malware scanner is not: uploads are
   * held unscanned and everything else still works, so removing the instance
   * from rotation would turn a partial outage into a total one.
   */
  readonly critical: boolean;
  check(): Promise<{ state: DependencyState; detail?: string }>;
}

export interface DependencyResult {
  readonly name: DependencyName;
  readonly status: DependencyState;
  readonly detail: string | null;
}

export type ReadinessStatus = 'ready' | 'degraded' | 'unavailable';

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly checks: readonly DependencyResult[];
}

/**
 * Answers "should this instance receive traffic".
 *
 * Probes register themselves as their modules are built, rather than being
 * listed here. TAB 02 stands up the service with no backing service wired, so
 * the registry starts empty and the honest answer is `ready` with no checks --
 * this instance genuinely has nothing it depends on yet. TABs 04, 06 and 08
 * register the database, object store and scanner probes as they arrive, and
 * the answer narrows on its own.
 *
 * The alternative -- listing four probes now and having them report `up`
 * against services that do not exist -- would make the first real outage
 * invisible.
 */
@Injectable()
export class ReadinessService {
  private readonly probes = new Map<DependencyName, DependencyProbe>();

  register(probe: DependencyProbe): void {
    this.probes.set(probe.name, probe);
  }

  registered(): readonly DependencyName[] {
    return [...this.probes.keys()];
  }

  async report(): Promise<ReadinessReport> {
    const probes = [...this.probes.values()];

    const checks = await Promise.all(
      probes.map(async (probe): Promise<DependencyResult & { critical: boolean }> => {
        try {
          const outcome = await probe.check();
          return {
            name: probe.name,
            status: outcome.state,
            detail: outcome.detail ?? null,
            critical: probe.critical,
          };
        } catch (error) {
          // A probe that throws is a dependency that is down. Never let a
          // failing check read as a passing one.
          return {
            name: probe.name,
            status: 'down',
            detail: error instanceof Error ? error.message : 'probe failed',
            critical: probe.critical,
          };
        }
      }),
    );

    const anyCriticalDown = checks.some((check) => check.critical && check.status === 'down');
    const anyDown = checks.some((check) => check.status === 'down');

    const status: ReadinessStatus = anyCriticalDown ? 'unavailable' : anyDown ? 'degraded' : 'ready';

    return {
      status,
      checks: checks.map(({ name, status: state, detail }) => ({ name, status: state, detail })),
    };
  }
}
