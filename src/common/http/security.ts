import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppConfig } from '../../config/app-config';
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
  sanitiseCorrelationId,
} from '../correlation/correlation';
import { StructuredLogger } from '../logging/logger';
import { PROBLEM_CONTENT_TYPE, ProblemType } from '../problem/problem';

/**
 * The baseline every request passes through, applied to the Fastify instance
 * before any route exists so nothing can be added later that bypasses it.
 */
export async function applySecurity(
  app: FastifyInstance,
  config: AppConfig,
  logger: StructuredLogger,
): Promise<void> {
  await app.register(helmet, {
    // Strict-Transport-Security only where TLS actually terminates in front of
    // us. Sending it from a plain-HTTP development server teaches a browser to
    // refuse the developer's own localhost for the next six months.
    hsts:
      config.EBPCO_ENVIRONMENT === 'development'
        ? false
        : { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    // This service returns JSON and never HTML, so the safest policy is one
    // that permits nothing at all.
    //
    // `useDefaults: false` is the load-bearing part. Helmet's defaults merge in
    // script-src 'self', style-src with 'unsafe-inline', font-src https: and
    // more -- sensible for a web page, meaningless for an API that never emits
    // markup, and each one a permission granted for no reason. A smoke test
    // against the running service is what caught the merge; the unit test had
    // only asserted that default-src 'none' was present, which it was.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Health and readiness are polled continuously by infrastructure that is
    // not an abuse source; rate limiting them would take an instance out of
    // rotation for being monitored.
    allowList: (request) => request.url === '/health' || request.url === '/ready',
    // Same shape as every other error the service returns.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      type: ProblemType.tooManyRequests,
      title: 'Too many requests',
      status: 429,
      detail: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
  });

  // One id per request, accepted from the caller only if it is plausibly ours,
  // echoed back on the response, and available to every log line in between.
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const supplied = sanitiseCorrelationId(request.headers[CORRELATION_HEADER]);
    const correlationId = supplied ?? newCorrelationId();
    void reply.header(CORRELATION_HEADER, correlationId);
    // `request.ip` honours trustProxy when it is configured, so this is the
    // caller's address rather than the load balancer's wherever the deployment
    // says so.
    runWithCorrelationId(correlationId, done, request.ip);
  });

  // A request that has not finished within the configured budget is abandoned
  // with a well-formed error rather than being allowed to hold a connection
  // open indefinitely.
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const timer = setTimeout(() => {
      if (!reply.sent) {
        void reply
          .status(503)
          .header('content-type', PROBLEM_CONTENT_TYPE)
          .send({
            type: ProblemType.serviceUnavailable,
            title: 'The request took too long',
            status: 503,
            instance: request.url,
          });
      }
    }, config.REQUEST_TIMEOUT_MS);
    timer.unref();
    void reply.raw.on('finish', () => clearTimeout(timer));
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    logger.info('request', {
      method: request.method,
      // The matched route, never the raw URL: a raw URL carries path
      // parameters, and a path parameter is an applicant's application id.
      route: request.routeOptions?.url ?? 'unmatched',
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
    done();
  });
}
