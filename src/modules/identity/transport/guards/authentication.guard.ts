import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { ProblemException, ProblemType } from '../../../../common/problem/problem';
import { AccessTokenClaims } from '../../domain/tokens';
import { TokenService } from '../../application/token.service';
import { IS_PUBLIC, REQUIRED_SCOPES } from './public.decorator';

/** The authenticated caller, attached to the request for handlers to read. */
export interface AuthenticatedRequest extends FastifyRequest {
  caller?: AccessTokenClaims;
}

/**
 * Deny by default.
 *
 * Registered globally, so a new controller is protected the moment it exists
 * and opting out is a visible `@Public()` in the diff. The inverse — a guard
 * applied per route — means the failure mode of forgetting is an open endpoint,
 * and that failure is silent.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = bearerFrom(request.headers.authorization);

    if (presented === null) {
      throw new ProblemException(
        ProblemType.unauthorized,
        'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.tokens.verifyAccessToken(presented);
    } catch {
      // One answer for expired, forged, malformed and unknown. Telling a caller
      // which would help them work out what they hold.
      throw new ProblemException(
        ProblemType.unauthorized,
        'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.caller = claims;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== undefined && required.length > 0) {
      const held = new Set<string>(claims.scopes);
      const missing = required.filter((scope) => !held.has(scope));
      if (missing.length > 0) {
        // 403 and not 404: the caller is authenticated and this is a route, not
        // a record. Object-level checks -- "is this application yours" -- answer
        // 404 instead, and those live in the domain layer where the object is.
        throw new ProblemException(
          ProblemType.forbidden,
          'Not permitted',
          HttpStatus.FORBIDDEN,
          'This account does not hold the permission this action requires.',
        );
      }
    }

    return true;
  }
}

function bearerFrom(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length === 0 ? null : token;
}
