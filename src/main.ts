import 'reflect-metadata';

import { ConfigurationError, loadConfig } from './config/app-config';
import { StructuredLogger } from './common/logging/logger';
import { createApp } from './bootstrap';

/**
 * The process entry point. Its only jobs are to fail loudly on bad
 * configuration and to bind the port.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // Before the logger exists, and deliberately on stderr in plain text: an
      // operator reading a crash loop needs to see what is missing, not parse
      // JSON to find out.
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = new StructuredLogger(config.LOG_LEVEL ?? 'info');
  const app = await createApp(config, logger);

  // 0.0.0.0 because the process runs in a container and must accept traffic
  // from outside its own network namespace.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  logger.info('listening', {
    port: config.PORT,
    environment: config.EBPCO_ENVIRONMENT,
    contractVersion: config.CONTRACT_VERSION,
    commit: config.BUILD_COMMIT,
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
