import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import { ROLE_SCOPES, StaffRole } from '../domain/account';
import { DirectoryRefusal, StaffDirectoryService, isStaffRole } from '../application/staff-directory.service';
import { TotpService } from '../application/totp.service';

/**
 * The Users & Roles screen, over HTTP.
 *
 * Everything here is gated on `staff:administer`, which after WP-01 is held by
 * `administrator` and `super-admin` and by nothing else. The refusals that
 * matter — an administrator changing their own roles, or setting another
 * officer's password — are enforced in the service, not here: a rule that lives
 * in a controller is a rule the next caller of the service does not have.
 */

const roleShape = z.string().refine(isStaffRole, {
  message: `must be one of: ${Object.keys(ROLE_SCOPES).join(', ')}`,
});

const createShape = z.object({
  email: z.string().email().max(320),
  // An account with no roles is legitimate: created now, assigned when the
  // officer's posting is confirmed. It simply has no staff scope until then.
  roles: z.array(roleShape).max(10).default([]),
}).strict();

const rolesShape = z.object({
  roles: z.array(roleShape).max(10),
}).strict();

const disableShape = z.object({
  reason: z.string().min(3).max(2000).optional(),
}).strict();

const patchShape = z.object({
  email: z.string().email().max(320),
}).strict();

function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const result = shape.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`, message: issue.message,
      })),
    );
  }
  return result.data;
}

/** The refusals, mapped once so every route answers the same way. */
function refuse(refusal: DirectoryRefusal): never {
  if (refusal.reason === 'not-found') throw ProblemException.notFound(refusal.detail);
  if (refusal.reason === 'email-taken') {
    throw new ProblemException(
      ProblemType.conflict, 'That address is already in use', HttpStatus.CONFLICT, refusal.detail,
    );
  }
  // Self-administration and non-staff subjects are both "you may not do this",
  // not "this does not exist" — an administrator is entitled to know the
  // account is there and that the rule is what stopped them.
  throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, refusal.detail);
}

function actorOf(request: AuthenticatedRequest): { accountId: string; role: string } {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, role: 'administrator' };
}

@Controller('staff/users')
export class StaffDirectoryController {
  constructor(
    private readonly directory: StaffDirectoryService,
    private readonly totp: TotpService,
  ) {}

  /**
   * Re-issue an officer's second factor.
   *
   * The action the directory has always REPORTED the need for — it returns
   * `mfaRequired` and `mfaEnrolled` for every account — and never offered. Six
   * roles require a factor, sign-in refuses without one, enrolling needs a
   * session the officer cannot obtain, and password reset issues none. An
   * officer who lost their phone, and every account created holding such a
   * role, had no way back.
   *
   * The provisioning URI is returned ONCE, to the administrator, to hand over
   * out of band. It is deliberately not a self-service flow: an account that
   * could sign in far enough to re-enrol its own factor could disable the
   * protection by clearing it, which is exactly what the sign-in refusal exists
   * to prevent.
   */
  @Post(':userId/mfa/reissue')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:administer')
  async reissueMfa(
    @Param('userId') userId: string, @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const result = await this.totp.reissue({
      accountId: userId, actorAccountId: actor.accountId, actorRole: actor.role,
    });

    if (!result.ok) {
      if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
      throw new ProblemException(
        ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail);
    }
    return {
      uri: result.value.uri,
      nextStep: 'Give this to the officer now. It is shown once and cannot be retrieved. '
        + 'Their first sign-in must use the NEXT code, because activation spends the current one.',
    };
  }

  @Get()
  @RequireScopes('staff:administer')
  async list(@Query() query: unknown): Promise<Record<string, unknown>> {
    const filters = parse(
      z.object({
        role: z.string().refine(isStaffRole).optional(),
        status: z.enum(['Active', 'Disabled', 'Pending']).optional(),
      }).strict(),
      query ?? {},
    );
    return {
      data: await this.directory.list({
        ...(filters.role === undefined ? {} : { role: filters.role as StaffRole }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      }),
    };
  }

  @Get(':userId')
  @RequireScopes('staff:administer')
  async detail(@Param('userId') userId: string): Promise<Record<string, unknown>> {
    const user = await this.directory.byId(userId);
    if (user === null) throw ProblemException.notFound('No such staff account.');
    return { ...user };
  }

  /**
   * Creates the account WITHOUT a password.
   *
   * The officer sets one through the existing reset flow. See the service for
   * why an administrator setting it would make the audit trail say something
   * false while remaining internally consistent.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:administer')
  async create(
    @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(createShape, body);
    const actor = actorOf(request);
    const result = await this.directory.create({
      email: input.email,
      roles: input.roles as StaffRole[],
      actor: actor.accountId,
      actorRole: actor.role,
    });
    if (!result.ok) refuse(result);
    return {
      ...result.user,
      // Said in the response rather than left for the administrator to
      // discover: the account cannot be signed into until the officer sets a
      // password, and nobody is emailed automatically yet.
      nextStep: 'The officer must set a password through the account-recovery flow before they can sign in.',
    };
  }

  @Patch(':userId')
  @RequireScopes('staff:administer')
  update(@Param('userId') userId: string, @Body() body: unknown): Record<string, unknown> {
    // Validated first even though it always refuses: a malformed body should be
    // told it is malformed, and answering "not available" to a request that was
    // also wrong hides the second problem until the first is fixed.
    parse(patchShape, body);
    // Deliberately not implemented rather than half-implemented. Changing an
    // officer's address changes the identity they sign in with and the address
    // a recovery ticket is sent to, so it is an account-takeover step unless it
    // is paired with re-verification — which does not exist yet. Refused
    // explicitly so the portal gets an answer it can show, instead of a 404
    // that reads as "wrong URL".
    throw new ProblemException(
      ProblemType.conflict,
      'Changing a staff address is not available',
      HttpStatus.CONFLICT,
      'It moves both the sign-in identity and where a recovery ticket is delivered, so it needs '
      + 're-verification that has not been built. Disable the account and create the new address instead.',
    );
  }

  @Post(':userId/roles')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async setRoles(
    @Req() request: AuthenticatedRequest, @Param('userId') userId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(rolesShape, body);
    const actor = actorOf(request);
    const result = await this.directory.setRoles({
      id: userId, roles: input.roles as StaffRole[],
      actor: actor.accountId, actorRole: actor.role,
    });
    if (!result.ok) refuse(result);
    return { ...result.user };
  }

  @Post(':userId/disable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async disable(
    @Req() request: AuthenticatedRequest, @Param('userId') userId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(disableShape, body ?? {});
    const actor = actorOf(request);
    const result = await this.directory.setDisabled({
      id: userId, disabled: true, actor: actor.accountId, actorRole: actor.role,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    if (!result.ok) refuse(result);
    return { ...result.user };
  }

  @Post(':userId/enable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async enable(
    @Req() request: AuthenticatedRequest, @Param('userId') userId: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const result = await this.directory.setDisabled({
      id: userId, disabled: false, actor: actor.accountId, actorRole: actor.role,
    });
    if (!result.ok) refuse(result);
    return { ...result.user };
  }

  @Get(':userId/sessions')
  @RequireScopes('staff:administer')
  async sessions(@Param('userId') userId: string): Promise<Record<string, unknown>> {
    const user = await this.directory.byId(userId);
    if (user === null) throw ProblemException.notFound('No such staff account.');
    return { data: await this.directory.sessionsOf(userId) };
  }

  @Delete(':userId/sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('staff:administer')
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    const actor = actorOf(request);
    const result = await this.directory.revokeSession({
      id: userId, sessionId, actor: actor.accountId, actorRole: actor.role,
    });
    if (!result.ok) refuse(result);
  }
}
