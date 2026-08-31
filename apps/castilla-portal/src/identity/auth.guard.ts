import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { ProblemException } from '../http/problem';
import { IdentityService, Principal } from './identity.service';
import { Scope } from './roles';

export const REQUIRED_SCOPES = 'required-scopes';

/** Declares the scopes a route needs. Absent means the route is public. */
export const RequireScopes = (...scopes: Scope[]): MethodDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
}

/**
 * The single place a scope is checked.
 *
 * FAIL-CLOSED: a route with no declared scopes is public, and every route that
 * declares one is refused unless the principal holds it. There is no
 * development shortcut and no fabricated session — that exact convenience
 * shipped in a sibling repository and had to be removed.
 *
 * An unauthenticated caller gets 404 rather than 401 on a staff route, so an
 * authorisation failure and a missing record are indistinguishable: probing for
 * which staff endpoints exist should tell an anonymous caller nothing.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Scope[] | undefined>(
      REQUIRED_SCOPES, [context.getHandler(), context.getClass()]);

    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;

    const principal = await this.identity.authenticate(token);
    if (principal === null) throw ProblemException.notFound('Resource', request.url);

    const missing = required.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) {
      // A signed-in staff member IS told they lack the scope: they are known,
      // and 'this page is missing' would send them hunting for a bug.
      throw ProblemException.forbidden(
        `This account holds the ${principal.role} role, which does not grant ${missing.join(', ')}.`);
    }

    request.principal = principal;
    return true;
  }
}
