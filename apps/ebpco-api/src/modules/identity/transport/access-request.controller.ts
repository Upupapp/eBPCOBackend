import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req,
} from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { StaffRole } from '../domain/account';
import { AccessRequestService, Refusal } from '../application/access-request.service';
import { isStaffRole } from '../application/staff-directory.service';
import { RequireScopes, Public } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';

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

const LEVELS = ['view', 'view-edit'] as const;

const requestShape = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  mobile: z.string().min(7).max(40),
  officePosition: z.string().min(2).max(200),
  permitTypes: z.array(z.string().min(1).max(120)).min(1).max(30),
  requestedLevel: z.enum(LEVELS),
  // Long enough to be a sentence. A one-word justification is not one, and a
  // super admin approving on "pls" has been given nothing to weigh.
  justification: z.string().min(20).max(2000),
}).strict();

const approvalShape = z.object({
  roles: z.array(z.string().refine(isStaffRole)).min(1).max(6),
  level: z.enum(LEVELS),
  permitTypes: z.array(z.string().min(1).max(120)).min(1).max(30),
}).strict();

const rejectionShape = z.object({
  reason: z.string().min(3).max(1000),
}).strict();

function actorOf(request: AuthenticatedRequest): { accountId: string; role: string } {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(
      ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, role: 'super-admin' };
}

function refuse(refusal: Refusal): never {
  if (refusal.reason === 'not-pending') throw ProblemException.notFound(refusal.detail);
  throw new ProblemException(
    ProblemType.conflict, 'Cannot approve this request', HttpStatus.CONFLICT, refusal.detail);
}

/**
 * Asking to become staff.
 *
 * The only unauthenticated write in the admin surface, and it cannot create an
 * account. `/auth/register` still mints an applicant with no roles; this
 * records that somebody asked, and a super admin decides. Both properties are
 * asserted rather than assumed — see test/staff-access-control.e2e-spec.ts.
 */
@Controller('auth')
export class AccessRequestController {
  constructor(private readonly requests: AccessRequestService) {}

  @Public()
  @Post('access-request')
  @HttpCode(HttpStatus.ACCEPTED)
  async raise(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const input = parse(requestShape, body);

    // 202 on every path from here. A malformed body IS reported — that is the
    // caller's own input — but whether the address is known, already has an
    // open request, or is rate-limited is not, because an endpoint that answers
    // differently tells anyone who asks which addresses belong to LGU staff.
    // Same rule as /auth/register, for the same reason.
    await this.requests.raise({
      fullName: input.fullName,
      email: input.email,
      mobile: input.mobile,
      officePosition: input.officePosition,
      permitTypes: input.permitTypes,
      requestedLevel: input.requestedLevel,
      justification: input.justification,
    }, request.ip);
  }
}

/**
 * Working the queue. `staff:administer` throughout.
 *
 * A role that could grant itself authority is not access control, so every
 * route here requires the administration scope — including the read, because
 * the queue holds names, mobile numbers and written justifications from people
 * who may never become staff.
 */
@Controller('staff/access-requests')
export class StaffAccessRequestsController {
  constructor(private readonly requests: AccessRequestService) {}

  @Get()
  @RequireScopes('staff:administer')
  async pending(@Query() query: unknown): Promise<Record<string, unknown>> {
    const filters = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        // Cursor, not offset: the queue changes while it is being worked, and
        // an offset silently skips a request when one ahead of it is decided.
        afterRaisedAt: z.string().datetime().optional(),
        afterId: z.string().uuid().optional(),
      }).strict(),
      query ?? {},
    );

    const after = filters.afterRaisedAt !== undefined && filters.afterId !== undefined
      ? { raisedAt: new Date(filters.afterRaisedAt), id: filters.afterId }
      : undefined;
    const data = await this.requests.pending(filters.limit ?? 25, after);
    const last = data[data.length - 1];

    return {
      data,
      // Absent when the page is not full: there is nothing after it.
      ...(last === undefined || data.length < (filters.limit ?? 25) ? {} : {
        next: { afterRaisedAt: last.raisedAt.toISOString(), afterId: last.id },
      }),
    };
  }

  @Post(':id/approve')
  @RequireScopes('staff:administer')
  async approve(
    @Param('id') id: string, @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(approvalShape, body);
    const result = await this.requests.approve(id, {
      roles: input.roles as StaffRole[],
      level: input.level,
      permitTypes: input.permitTypes,
    }, actorOf(request));

    if (!result.ok) refuse(result);
    return {
      accountId: result.value.accountId,
      nextStep: 'The officer must set a password through the account-recovery flow '
        + 'before they can sign in.',
    };
  }

  @Post(':id/reject')
  @RequireScopes('staff:administer')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string, @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<void> {
    const input = parse(rejectionShape, body);
    const result = await this.requests.reject(id, input.reason, actorOf(request));

    // The reason is recorded and is NOT sent to the requester. A rejection that
    // explained itself would disclose which addresses are known, which roles
    // exist, and what this LGU considers a good enough justification.
    if (!result.ok) refuse(result);
  }
}
