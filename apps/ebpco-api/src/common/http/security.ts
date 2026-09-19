import cors from '@fastify/cors';
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

  // The two real browser clients this API serves, and nothing else. Neither
  // is inferred or wildcarded: `PORTAL_BASE_URL`/`USER_PORTAL_BASE_URL`
  // already exist for building the links a password-reset email sends, so
  // they are also already the operator's own statement of exactly which two
  // origins are the real Admin Portal and the real Citizen Portal — reusing
  // them here means a deployment that gets its portal URLs right gets CORS
  // right for free, with no second setting to keep in sync.
  //
  // A same-origin deployment (portal and API behind one gateway) never sends
  // an Origin header that needs this at all; this is what makes the OTHER
  // real topology — portal and API on separate hosts, e.g. two independent
  // Netlify sites calling a separately hosted API — work instead of failing
  // silently in a way only a browser's console ever shows. `credentials:
  // false` because auth here is a bearer token in an Authorization header,
  // never a cookie — there is nothing for the browser to attach automatically
  // that CORS credentials mode exists to gate.
  //
  // Deduped with a Set: a deployment could legitimately serve both portals
  // from the same origin (one app, two routes) and set both variables to
  // match — registering the same origin twice is harmless to
  // `@fastify/cors` but says the config was not thought through. (Local
  // development's own defaults are two different ports, 4200 and 4201, so
  // this is a real possibility to guard, not a hypothetical one.)
  //
  // `methods` is spelled out because `@fastify/cors` defaults to
  // `GET,HEAD,POST` and nothing else. Every route here is one of those or
  // PUT/PATCH/DELETE, and the Admin Portal uses PUT and DELETE — so under
  // the default, the first cross-origin deployment (2026-09-19, the Netlify
  // portal against the Linode API) would have signed in fine and then failed
  // every save that was not a POST, with a preflight rejection only the
  // browser console reports. Local development never saw it because the dev
  // server proxies same-origin and no preflight is ever sent.
  await app.register(cors, {
    origin: [...new Set([config.PORTAL_BASE_URL, config.USER_PORTAL_BASE_URL])],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: false,
    exposedHeaders: [CORRELATION_HEADER],
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
