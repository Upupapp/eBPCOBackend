import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { ACCOUNT_REPOSITORY, AccountRepository } from '../application/account.repository';
import { IdentityService } from '../application/identity.service';
import { Public } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';

/**
 * The identity endpoints.
 *
 * Every unauthenticated one returns the same answer whether or not the address
 * is registered. That is the single constraint shaping this controller: an
 * applicant register that can be enumerated tells anyone who asks which of
 * their neighbours has applied for a building permit.
 */

const credentials = z.object({
  grantType: z.literal('password'),
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const registration = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  mobileNumber: z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'must be 09XXXXXXXXX or +639XXXXXXXXX'),
  password: z.string().min(1),
});

const refreshRequest = z.object({ refreshToken: z.string().min(1) });
const revokeRequest = z.object({ allSessions: z.boolean().optional() });
const forgotRequest = z.object({ email: z.string().email() });
const resetRequest = z.object({ token: z.string().min(1), password: z.string().min(1) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(credentials, body);
    const outcome = await this.identity.authenticate(input.email, input.password, input.totp);

    if (!outcome.ok) {
      if (outcome.reason === 'mfa-required') {
        // Distinguishable only because the caller has already proven the
        // password, so it reveals nothing they did not already know.
        throw new ProblemException(
          '/problems/mfa-required',
          'A second factor is required',
          HttpStatus.UNAUTHORIZED,
          'Enter the code from your authenticator app.',
        );
      }
      throw new ProblemException(
        ProblemType.unauthorized,
        'Those credentials were not accepted',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      accessToken: outcome.tokens.accessToken,
      refreshToken: outcome.tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: outcome.tokens.expiresIn,
      scopes: outcome.tokens.scopes,
    };
  }

  @Public()
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(refreshRequest, body);
    try {
      const tokens = await this.identity.refresh(input.refreshToken);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        scopes: tokens.scopes,
      };
    } catch {
      // Including replay. A caller who learns their token was rejected *because
      // it was replayed* learns the theft was detected.
      throw new ProblemException(
        ProblemType.unauthorized,
        'That refresh token was not accepted',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  @Post('revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const input = parse(revokeRequest, body ?? {});
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    if (input.allSessions === true) {
      await this.identity.signOutEverywhere(caller.sub);
      return;
    }
    await this.identity.signOut(caller.sid);
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() body: unknown): Promise<void> {
    const input = parse(registration, body);
    const result = await this.identity.register(input);

    // A weak password IS reported: that is the caller's own input, not a fact
    // about who else has an account.
    if (!result.accepted) {
      throw ProblemException.validation(
        result.rejections.map((rejection) => ({ pointer: '/password', message: rejection.message })),
      );
    }
    // Otherwise 202, identically, whether or not the address was already used.
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgot(@Body() body: unknown): Promise<void> {
    const input = parse(forgotRequest, body);
    // The ticket is deliberately discarded here: in production it is delivered
    // out of band. Returning it would make this endpoint a password reset for
    // anyone who knows an address.
    await this.identity.beginPasswordReset(input.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reset(@Body() body: unknown): Promise<void> {
    const input = parse(resetRequest, body);
    const result = await this.identity.completePasswordReset(input.token, input.password);

    if (!result.ok) {
      if (result.rejections.length > 0) {
        throw ProblemException.validation(
          result.rejections.map((rejection) => ({ pointer: '/password', message: rejection.message })),
        );
      }
      throw new ProblemException(
        ProblemType.badRequest,
        'That reset link is no longer valid',
        HttpStatus.BAD_REQUEST,
        'Request a new one.',
      );
    }
  }
}

@Controller('me')
export class MeController {
  constructor(@Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository) {}

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    const account = await this.accounts.findById(caller.sub);
    // 404 rather than 401: the token verified, so this is a record question.
    if (account === null) throw ProblemException.notFound();

    // Never the verifier, the salt, or the TOTP secret.
    //
    // Roles and scopes ARE returned, and are not a disclosure: they describe
    // what this caller may do, which the caller learns anyway from the first
    // request that succeeds or is refused. A staff portal needs them to decide
    // what to put on screen, and the alternative — a client guessing from a
    // role name it invented — is how a menu comes to offer actions the server
    // will refuse.
    //
    // The scopes come from the token rather than being recomputed from the
    // roles, so what is reported is exactly what will be enforced. A token
    // issued before a role changed carries the old set, and saying otherwise
    // would describe a session the holder does not have.
    return {
      id: account.id,
      kind: account.kind,
      email: account.email,
      roles: account.roles,
      scopes: caller.scopes,
      emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
    };
  }
}
