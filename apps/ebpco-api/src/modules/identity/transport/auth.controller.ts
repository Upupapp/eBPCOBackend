import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { ACCOUNT_REPOSITORY, AccountRepository } from '../application/account.repository';
import { IdentityService } from '../application/identity.service';
import { ErasureService } from '../../compliance/application/erasure.service';
import { DataExportService } from '../../compliance/application/data-export.service';
import { Public, RequireScopes } from './guards/public.decorator';
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
  email: z.string().email().max(320),
  // Bounded. scrypt's cost comes from its parameters rather than the input
  // length, but the body limit still allows a one-megabyte "password" that has
  // to be read, copied and hashed on every attempt — and an unbounded field on
  // the one endpoint an attacker can call without credentials is free work for
  // them. 512 is far above anything a passphrase needs and far below anything
  // worth defending against.
  password: z.string().min(1).max(512),
  // Six digits. Accepting an arbitrary string here let a caller send a
  // megabyte to a comparison that only ever looks at six characters.
  totp: z.string().regex(/^\d{6}$/, 'must be six digits').optional(),
});

const registration = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(320),
  mobileNumber: z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'must be 09XXXXXXXXX or +639XXXXXXXXX'),
  password: z.string().min(1).max(512),
});

const refreshRequest = z.object({ refreshToken: z.string().min(1) });
const revokeRequest = z.object({ allSessions: z.boolean().optional() });
const forgotRequest = z.object({ email: z.string().email().max(320) });
const resetRequest = z.object({
  token: z.string().uuid('must be a reset token'),
  password: z.string().min(1).max(512),
});

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
    // `mobileNumber` is validated above and was, until 2026-08-31, discarded
    // here — the service did not even accept it.
    const result = await this.identity.register({
      email: input.email,
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
      mobileNumber: input.mobileNumber,
    });

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
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly erasure: ErasureService,
    private readonly dataExports: DataExportService,
  ) {}

  /**
   * The RA 10173 §18 right to a portable copy of your own data.
   *
   * 202 and a request id, not the file. An export reads every application,
   * document record, payment and notification the applicant has, and doing that
   * inside a request times out for exactly the people with the most data — who
   * are the ones most likely to be asking.
   *
   * Pressing the button twice returns the SAME request rather than an error.
   * A second press is not a second request, and refusing would read as the LGU
   * declining to answer a statutory right.
   */
  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('profile:read')
  async requestExport(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return { ...(await this.dataExports.request(callerOf(request))) };
  }

  /**
   * Where a request has got to.
   *
   * The contract says the feed carries the result. It does not yet: emitting a
   * notification needs a catalog entry the mobile client can parse, and its
   * enum parser throws on an unknown type — so a notice sent before the client
   * knows the type is a crash on a handset. Until the mobile lane adds it, this
   * is how a client finds out, and saying so is better than sending a notice
   * with a dead deep link.
   */
  @Get('export/:requestId')
  @RequireScopes('profile:read')
  async exportStatus(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ): Promise<Record<string, unknown>> {
    const status = await this.dataExports.statusOf(callerOf(request), requestId);
    // Someone else's request answers the same as one that does not exist.
    if (status === null) throw ProblemException.notFound('No such export request.');
    return { ...status };
  }

  /**
   * A short-lived link to the produced file.
   *
   * Separate from the status so the link is minted at the moment it is asked
   * for rather than sitting in a status response somebody screenshots. It
   * expires with the request, and never outlives it.
   */
  @Get('export/:requestId/content')
  @RequireScopes('profile:read')
  async exportContent(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ): Promise<Record<string, unknown>> {
    const url = await this.dataExports.downloadUrl(callerOf(request), requestId);
    if (url === null) {
      throw ProblemException.notFound('That export is not available. It may still be being produced, or it may have expired.');
    }
    return { url };
  }

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    const account = await this.accounts.findById(caller.sub);
    // 404 rather than 401: the token verified, so this is a record question.
    if (account === null) throw ProblemException.notFound();

    // Never the verifier, the salt, or the TOTP secret.
    //
    // Roles and scopes ARE returned for staff, and are not a disclosure: the
    // caller learns both from the first request that succeeds or is refused.
    // A staff portal needs them to decide what to put on screen, and the
    // alternative -- a client guessing from a role name it invented -- is how a
    // menu comes to offer actions the server will refuse.
    //
    // The scopes come from the token rather than being recomputed from the
    // roles, so what is reported is exactly what will be enforced. A token
    // issued before a role changed carries the old set, and saying otherwise
    // would describe a session the holder does not have.
    const common = {
      id: account.id,
      kind: account.kind,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
    };

    if (account.kind === 'staff') {
      return { ...common, roles: account.roles, scopes: caller.scopes };
    }

    // An applicant's name and mobile number, which the mobile client reads to
    // greet them and to show what it will send an OTP to. Omitting them was a
    // real defect: the client fell back to empty strings, so every applicant
    // saw a blank name and an empty contact number, and nothing failed loudly
    // enough for anyone to notice. Found by putting a recorded response next to
    // the code that consumes it.
    const profile = await this.accounts.profileOf(account.id);
    return {
      ...common,
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      mobileNumber: profile?.mobileNumber ?? null,
    };
  }

  /**
   * The RA 10173 §16(e) right to erasure.
   *
   * 202 rather than 204: the request is accepted and the response says what was
   * erased and what survives. A 204 would be the LGU quietly keeping a permit
   * record while implying it kept nothing, and §16(e) is conditional on there
   * being an overriding legal obligation — so naming the obligation is what
   * makes the retention lawful rather than merely convenient.
   *
   * Not idempotency-keyed. Erasing an already-erased account returns the same
   * receipt, so a replayed request cannot cause a second erasure and a key
   * would guard nothing.
   */
  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('profile:write')
  async erase(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const result = await this.erasure.erase(callerOf(request));
    if (result.ok) {
      const { acceptedAt, erasedCategories, retainedCategories } = result.receipt;
      // `counts` stays out of the response: it names tables, which is internal
      // structure, and the contract's shape is what the client was built to.
      return { acceptedAt, erasedCategories, retainedCategories };
    }

    if (result.reason === 'not-found') throw ProblemException.notFound();
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
    );
  }
}

/**
 * The caller's own account id, from the token and from nowhere else.
 *
 * A function rather than a repeated guard, because every route on `/me` needs
 * it and the one that forgets is the one that takes an account id from
 * somewhere a caller can influence.
 */
function callerOf(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}
