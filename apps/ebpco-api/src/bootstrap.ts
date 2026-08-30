import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { SqlClient } from './persistence/sql-client';
import { applySecurity } from './common/http/security';
import { StructuredLogger } from './common/logging/logger';
import { ProblemDetailsFilter } from './common/problem/problem-details.filter';

/**
 * Builds the application without listening.
 *
 * Separated from `main.ts` so the end-to-end tests exercise the same wiring
 * production runs -- the same filters, the same hooks, the same limits. A test
 * that builds its own reduced app proves that app, not this one.
 */
export async function createApp(
  config: AppConfig,
  logger: StructuredLogger,
  /**
   * Supplied only by tests, which pass PGlite -- real PostgreSQL in-process --
   * so an end-to-end test exercises the actual SQL, the actual constraints and
   * the actual triggers rather than an in-memory stand-in that was written to
   * agree with it.
   */
  sqlClientOverride?: SqlClient,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // An unbounded body is a denial-of-service surface. The cap is
    // configurable because a document upload path needs a larger one than a
    // JSON path, and neither should be guessed at here.
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: config.TRUST_PROXY,
    // Fastify's own request logging is off: everything goes through the
    // redacting logger, so there is one place that decides what may be written.
    logger: false,
    // Reject a URL that only differs by case or trailing slash rather than
    // quietly serving it, so one route means one path in the audit trail.
    // Nested under routerOptions: Fastify 5 deprecated the top-level form.
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config, logger, sqlClientOverride),
    adapter,
    {
      logger: false,
      bufferLogs: true,
      // Nest's default is to print the resolution error through its own logger
      // and call process.exit(1). With `logger: false` that prints NOTHING —
      // the process vanishes with an exit code and no explanation, which is
      // what a wiring mistake looked like until this line existed. Throwing
      // instead lets main.ts report it and lets a test see it.
      abortOnError: false,
    },
  );

  await applySecurity(app.getHttpAdapter().getInstance(), config, logger);

  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();

  return app;
}
