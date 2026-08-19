import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { join } from 'node:path';

import { AppConfig, CONFIG } from '../config/app-config';
import { StructuredLogger } from '../common/logging/logger';
import { ReadinessService } from '../modules/health/readiness.service';
import { HealthModule } from '../modules/health/health.module';
import { PostgresClient } from './postgres-client';
import { SqlClient } from './sql-client';
import { applied, loadMigrations } from './migrator';

export const SQL_CLIENT = Symbol('EBPCO_SQL_CLIENT');

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
      provide: SQL_CLIENT,
      inject: [CONFIG, { token: SQL_CLIENT_OVERRIDE, optional: true }],
      useFactory: (config: AppConfig, override?: SqlClient | null): SqlClient =>
        override ?? PostgresClient.fromUrl(config.DATABASE_URL),
    },
  ],
  exports: [SQL_CLIENT],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQL_CLIENT) private readonly db: SqlClient,
    private readonly readiness: ReadinessService,
    private readonly logger: StructuredLogger,
  ) {
    this.readiness.register({
      name: 'database',
      // Critical: without it every route fails, so the instance should leave
      // rotation rather than serve errors.
      critical: true,
      check: async () => {
        try {
          await this.db.query('select 1');
        } catch (error) {
          return { state: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
        }

        const pending = await this.pendingMigrations();
        if (pending > 0) {
          return {
            state: 'down',
            detail: `${pending} migration(s) not applied — this build expects a schema the database does not have`,
          };
        }
        return { state: 'up' };
      },
    });
  }

  private async pendingMigrations(): Promise<number> {
    try {
      const expected = loadMigrations(MIGRATIONS_DIR);
      const history = await applied(this.db);
      return expected.length - history.length;
    } catch (error) {
      this.logger.warn('could not determine schema version', {
        error: error instanceof Error ? error : { message: String(error) },
      });
      return 0;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
