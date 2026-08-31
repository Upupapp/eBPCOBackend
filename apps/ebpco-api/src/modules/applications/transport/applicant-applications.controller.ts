import { Controller, Get, HttpStatus, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { ApplicantQueryService } from '../application/applicant-query.service';

/**
 * The applicant's own applications.
 *
 * A different path tree from `/staff/applications`, for the reason stated
 * there: one path that returns an officer's view or an applicant's view
 * depending on a token claim is one mistake away from serving the wrong one,
 * and the mistake is invisible in a URL.
 *
 * Nothing here takes an account id from the caller. It comes from the token,
 * always — an endpoint that accepted "whose applications" as a parameter is an
 * endpoint that will eventually be called with somebody else's.
 */

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function callerAccount(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  if (claims.kind !== 'applicant') {
    // A staff token reaching here is a routing mistake. Officers read
    // applications through /staff/applications, which applies the role filter.
    // Answering 403 rather than serving an empty list makes the mistake
    // visible instead of looking like an applicant with no applications.
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN,
      'Officers read applications through the staff surface.',
    );
  }
  return claims.sub;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

@Controller('applications')
export class ApplicantApplicationsController {
  constructor(private readonly applications: ApplicantQueryService) {}

  @Get()
  @RequireScopes('applications:read')
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(listQuery, query ?? {});
    const data = await this.applications.list(callerAccount(request), input.limit ?? 50);
    // `data`, not `items`. The contract said so and the mobile client's list
    // unwrapper accepts a bare array or `data` and THROWS on anything else —
    // so `items` would have been a crash on a handset, not a warning in a log.
    // Caught by validating a recorded response against the contract.
    return { data, nextCursor: null };
  }

  @Get(':applicationId')
  @RequireScopes('applications:read')
  async byId(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<Record<string, unknown>> {
    const found = await this.applications.byId(callerAccount(request), applicationId);
    // 404 for "not yours" as well as "not there". Telling an applicant that a
    // reference exists but is not theirs confirms a neighbour has applied.
    if (found === null) throw ProblemException.notFound('No such application.');
    return found;
  }

  /**
   * The documents on this application, and the office's verdict on each.
   *
   * C-2. A bare array, as the timeline is: the contract already has one shape
   * for "a list belonging to one application" and a second would be a second
   * idea for the same thing.
   *
   * Note this is also the ONLY route that returns a document id. Content
   * retrieval and resubmission both take one, and nothing served one before --
   * so a citizen could not re-download a file they had uploaded themselves.
   */
  @Get(':applicationId/documents')
  @RequireScopes('applications:read')
  async documents(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const documents = await this.applications.documents(callerAccount(request), applicationId);
    // 404 for "not yours" as well as "not there", the same as the detail. An
    // application of theirs with nothing uploaded yet returns [], which is a
    // different answer and a true one.
    if (documents === null) throw ProblemException.notFound('No such application.');
    return documents;
  }

  /**
   * The permit, once it exists.
   *
   * Separate from the application detail rather than folded into it: the detail
   * is read on every list refresh, and the permit is read once, at the end. A
   * join nobody needs on the common path is a join every caller pays for.
   */
  @Get(':applicationId/permit')
  @RequireScopes('applications:read')
  async permit(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<Record<string, unknown>> {
    const account = callerAccount(request);
    const permit = await this.applications.permit(account, applicationId);
    if (permit !== null) return { ...permit };

    // Two different absences, told apart. "Not yours" must stay
    // indistinguishable from "does not exist" — otherwise a reference number
    // confirms a neighbour has applied — but an applicant reading their OWN
    // application is entitled to know the permit is simply not issued yet,
    // rather than being told their application does not exist.
    const own = await this.applications.byId(account, applicationId);
    if (own === null) throw ProblemException.notFound('No such application.');
    throw ProblemException.notFound(
      'No permit has been issued for this application yet.');
  }

  @Get(':applicationId/timeline')
  @RequireScopes('applications:read')
  async timeline(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const entries = await this.applications.timeline(callerAccount(request), applicationId);
    if (entries === null) throw ProblemException.notFound('No such application.');
    // A bare array, as the contract declares. Wrapping it would be a second
    // shape for the same idea on one surface.
    return entries;
  }
}
