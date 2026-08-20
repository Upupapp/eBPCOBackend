import 'reflect-metadata';

import { ConfigurationError, loadConfig } from './config/app-config';
import { StructuredLogger } from './common/logging/logger';
import { DrainState, exitCodeFor, shutdown } from './common/lifecycle/shutdown';
import { DRAIN_STATE } from './persistence/persistence.module';
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

  let app;
  try {
    app = await createApp(config, logger);
  } catch (error) {
    // A wiring mistake, not a configuration one. Reported rather than left to
    // an exit code with no explanation.
    logger.error('the application could not be built', {
      error: error instanceof Error ? error : { message: String(error) },
    });
    process.exit(70); // EX_SOFTWARE
  }

  // 0.0.0.0 because the process runs in a container and must accept traffic
  // from outside its own network namespace.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  logger.info('listening', {
    port: config.PORT,
    environment: config.EBPCO_ENVIRONMENT,
    contractVersion: config.CONTRACT_VERSION,
    commit: config.BUILD_COMMIT,
  });

  const drain = app.get<DrainState>(DRAIN_STATE);

  // `once` per signal, and a guard across both: an orchestrator that sends
  // SIGTERM and then SIGINT would otherwise start a second shutdown while the
  // first is draining, and the second `close()` races the first.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void shutdown({
        drain,
        close: () => app.close(),
        logger,
        signal,
        config: {
          drainMs: config.SHUTDOWN_DRAIN_MS,
          deadlineMs: config.SHUTDOWN_DEADLINE_MS,
        },
      }).then((outcome) => process.exit(exitCodeFor(outcome)));
    });
  }
}

void main();
