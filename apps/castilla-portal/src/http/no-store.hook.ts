import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Marks everything that varies by who is asking as uncacheable.
 *
 * An `onSend` hook rather than an interceptor or middleware, because it is the
 * only one of the three that runs for EVERY response — including the 404 the
 * auth guard throws before any interceptor is reached. Those refusals are
 * exactly the responses most worth marking: they differ by caller, and a shared
 * cache holding one would serve one person's answer to the next.
 */
@Injectable()
export class NoStoreHook implements OnApplicationBootstrap {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const instance = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();

    instance.addHook('onSend', (
      request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (
        error: Error | null, value?: unknown) => void,
    ) => {
      const path = request.url.split('?')[0] ?? '';
      if (path.startsWith('/staff') || path === '/session'
          || path.startsWith('/api/staff') || path === '/api/session') {
        void reply.header('Cache-Control', 'private, no-store');
        // An ETag on a private response invites a cache to keep it keyed by
        // URL alone, which is the shared-cache failure by another route.
        void reply.removeHeader('ETag');
      }
      done(null, payload);
    });
  }
}
