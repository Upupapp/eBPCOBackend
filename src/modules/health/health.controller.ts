import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { AppConfig, CONFIG } from '../../config/app-config';
import { ReadinessService } from './readiness.service';

/**
 * The three operational endpoints, exactly as the contract defines them.
 *
 * All three are unauthenticated by design: a load balancer has no credentials,
 * and a probe that needs a token is a probe that fails for the wrong reason
 * during an identity outage. In exchange they disclose nothing an attacker
 * gains from -- no dependency hostnames, no versions of anything but this
 * service, no error text.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Liveness. Deliberately touches nothing.
   *
   * If this checked the database, a database outage would make every instance
   * fail liveness, the orchestrator would restart all of them, and a recoverable
   * dependency outage would become a total one.
   */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness. Answers 503 with the same body it answers 200 with -- the one
   * deliberate exception to the contract's problem+json rule, because the only
   * question the consumer asks is *which* dependency is down, and a Problem
   * Details document cannot say.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    const report = await this.readiness.report();
    void reply.status(report.status === 'unavailable' ? 503 : 200);
    return report;
  }

  @Get('version')
  version(): Record<string, string> {
    return {
      version: this.config.BUILD_COMMIT === 'unknown' ? '0.1.0-dev' : '0.1.0',
      commit: this.config.BUILD_COMMIT,
      builtAt: this.config.BUILD_TIME ?? new Date(0).toISOString(),
      environment: this.config.EBPCO_ENVIRONMENT,
      contractVersion: this.config.CONTRACT_VERSION,
    };
  }
}
