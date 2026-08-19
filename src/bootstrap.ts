import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
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
    AppModule.forConfig(config, logger),
    adapter,
    { logger: false, bufferLogs: true },
  );

  await applySecurity(app.getHttpAdapter().getInstance(), config, logger);

  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();

  return app;
}
