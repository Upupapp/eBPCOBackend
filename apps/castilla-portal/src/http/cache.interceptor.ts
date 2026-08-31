import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

import { CACHE_KEY, CACHE_POLICY, CachePolicy, ContentVersions } from './cache';

/**
 * ETags and Cache-Control for the public read API.
 *
 * The 304 is decided BEFORE the handler runs, and that ordering is the whole
 * point: `next.handle()` is never called on a match, so the repository is never
 * asked, and a revalidation costs a hash instead of a query.
 */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly versions: ContentVersions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const policy = this.reflector.get<CachePolicy | undefined>(
      CACHE_POLICY, context.getHandler());

    if (policy === undefined) {
      // Anything not explicitly marked cacheable is not cached, and anything
      // that varies by who is asking is explicitly not cacheable ANYWHERE. A
      // shared cache holding one editor's view of pending content and serving
      // it to the next caller is the failure this line prevents.
      if (request.url.startsWith('/staff') || request.url.startsWith('/session')) {
        void reply.header('Cache-Control', 'private, no-store');
      }
      return next.handle();
    }

    const keyOf = this.reflector.get<((params: Record<string, string>) => string) | undefined>(
      CACHE_KEY, context.getHandler());
    const key = keyOf === undefined
      ? request.url
      : keyOf((request.params ?? {}) as Record<string, string>);

    const etag = this.versions.etagFor(key);
    void reply.header('ETag', etag);
    void reply.header('Cache-Control',
      `public, max-age=${String(policy.maxAge)}, `
      + `stale-while-revalidate=${String(policy.staleWhileRevalidate)}`);

    const offered = request.headers['if-none-match'];
    if (typeof offered === 'string' && matches(offered, etag)) {
      void reply.status(304);
      // Short-circuited: the handler, and therefore the database, is untouched.
      return of(undefined);
    }

    return next.handle().pipe(tap(() => {
      void reply.header('ETag', etag);
    }));
  }
}

/** `If-None-Match` may carry a list, and `*` matches anything present. */
function matches(offered: string, etag: string): boolean {
  if (offered.trim() === '*') return true;
  return offered.split(',').map((tag) => tag.trim()).includes(etag);
}
