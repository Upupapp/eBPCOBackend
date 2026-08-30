import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import { TotpService } from '../application/totp.service';

/**
 * An officer enrolling their own second factor.
 *
 * Their OWN, on `/me`, and not an administrator's act. Enrolling a factor for
 * somebody else means holding their secret, and a factor the administrator
 * could reproduce is not a second factor — it is the same authority wearing a
 * different name. The staff directory can create and disable an account; it
 * cannot become one.
 *
 * `profile:write`, which every account carries, because managing your own
 * record is not a job function and the roles that most need this are precisely
 * the ones that cannot sign in until they have done it.
 */

const activateShape = z.object({
  code: z.string().regex(/^\d{6}$/, 'must be the six-digit code from the app'),
}).strict();

function accountOf(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}

@Controller('me/mfa')
export class MfaController {
  constructor(private readonly totp: TotpService) {}

  @Get()
  @RequireScopes('profile:read')
  async status(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return { ...await this.totp.status(accountOf(request)) };
  }

  /**
   * Offers a secret, and requires nothing of the account yet.
   *
   * The secret is returned ONCE and never again — it is shown so the officer
   * can add it to an app, and an endpoint that would hand it back later would
   * make every subsequent request a way to steal the factor.
   */
  @Post('enrol')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('profile:write')
  async enrol(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const result = await this.totp.begin({ accountId: accountOf(request) });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.conflict, 'The account is not in a state that permits this',
        HttpStatus.CONFLICT, result.detail,
      );
    }
    return {
      ...result.value,
      detail: 'Add this to an authenticator app, then confirm a code. Nothing changes about '
        + 'signing in until you do.',
    };
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('profile:write')
  async activate(
    @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = activateShape.safeParse(body);
    if (!parsed.success) {
      throw ProblemException.validation(
        parsed.error.issues.map((issue) => ({
          pointer: `/${issue.path.join('/')}`, message: issue.message,
        })),
      );
    }
    const result = await this.totp.activate({
      accountId: accountOf(request), code: parsed.data.code,
    });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.conflict, 'The code was not accepted',
        HttpStatus.CONFLICT, result.detail,
      );
    }
    return { enrolled: true };
  }
}
