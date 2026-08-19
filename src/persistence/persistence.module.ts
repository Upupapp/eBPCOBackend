import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { join } from 'node:path';

import { AppConfig, CONFIG } from '../config/app-config';
import { StructuredLogger } from '../common/logging/logger';
import { ReadinessService } from '../modules/health/readiness.service';
import { HealthModule } from '../modules/health/health.module';
import { PostgresClient } from './postgres-client';
import { SqlClient } from './sql-client';
import { applied, loadMigrations } from './migrator';
import { compareSchema, describe, servesTraffic } from './schema-state';
import { DrainState } from '../common/lifecycle/shutdown';

export const SQL_CLIENT = Symbol('EBPCO_SQL_CLIENT');

/**
 * Shared between the shutdown sequence, which sets it, and the readiness probe,
 * which reads it. Provided here rather than in a module of its own because the
 * database probe is the one that has to honour it: an instance that is draining
 * must stop being routed to before it stops accepting.
 */
export const DRAIN_STATE = Symbol('EBPCO_DRAIN_STATE');

/** Injected by tests to run against PGlite instead of a server. */
export const SQL_CLIENT_OVERRIDE = Symbol('EBPCO_SQL_CLIENT_OVERRIDE');

export const MIGRATIONS_DIR = join(__dirname, '../../db/migrations');

/**
 * The database connection, and the readiness probe that reports on it.
 *
 * The service does NOT migrate on boot. Migrations run in the deployment
 * pipeline, before the new version is rolled out, because a process that
 * migrates on start means N replicas racing to alter the same schema and a
 * rollback that has to guess what was applied. What it does instead is refuse
 * to report ready when the schema is behind the code — so a deploy that skipped
 * its migration step fails its health gate rather than serving requests against
 * a schema it does not understand.
 */
@Global()
@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: DRAIN_STATE,
      useFactory: (): DrainState => new DrainState(),
    },
    {
      provide: SQL_CLIENT,
      inject: [CONFIG, { token: SQL_CLIENT_OVERRIDE, optional: true }],
      useFactory: (config: AppConfig, override?: SqlClient | null): SqlClient =>
        override ?? PostgresClient.fromUrl(config.DATABASE_URL, {
          max: config.DB_POOL_MAX,
          connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
          statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
        }),
    },
  ],
  exports: [SQL_CLIENT, DRAIN_STATE],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQL_CLIENT) private readonly db: SqlClient,
    @Inject(DRAIN_STATE) private readonly drain: DrainState,
    private readonly readiness: ReadinessService,
    private readonly logger: StructuredLogger,
  ) {
    this.readiness.register({
      name: 'database',
      // Critical: without it every route fails, so the instance should leave
      // rotation rather than serve errors.
      critical: true,
      check: async () => {
        // Checked FIRST, and reported as down rather than degraded. An instance
        // that has been told to stop must leave rotation before it stops
        // accepting, or the balancer keeps routing to a process that is closing
        // and every one of those requests is a 502 an applicant sees.
        if (this.drain.isDraining) {
          return { state: 'down', detail: 'shutting down; draining in-flight requests' };
        }

        try {
          await this.db.query('select 1');
        } catch (error) {
          return { state: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
        }

        const verdict = await this.schemaState();
        if (verdict === null) return { state: 'up' };
        if (!servesTraffic(verdict)) return { state: 'down', detail: describe(verdict) };
        if (verdict.state === 'ahead') {
          // Up, and said out loud. Refusing here would take the service down
          // during every rolling deploy that migrates before it rolls -- see
          // schema-state.ts for why that is the wrong trade.
          this.logger.warn('schema is ahead of this build', { detail: describe(verdict) });
        }
        return { state: 'up' };
      },
    });
  }

  /**
   * The schema verdict, or null if it could not be determined.
   *
   * Null rather than a guess. An unreadable migrations directory or an
   * unreadable ledger is an operational problem in its own right, and answering
   * "behind" would send an operator to run migrations that are not the issue —
   * while answering "current" would be a claim nothing supports. It is logged
   * and the probe falls back to the connectivity check, which is the one thing
   * that has actually been established.
   */
  private async schemaState(): Promise<ReturnType<typeof compareSchema> | null> {
    try {
      return compareSchema(loadMigrations(MIGRATIONS_DIR), await applied(this.db));
    } catch (error) {
      this.logger.warn('could not determine schema version', {
        error: error instanceof Error ? error : { message: String(error) },
      });
      return null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
