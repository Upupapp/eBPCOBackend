import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import { ARCHIVE_KINDS, ArchiveKind, ArchiveOutcome, ArchiveService } from '../application/archive.service';
import { StepCheck } from '../application/step-guard';
import { TeamService } from '../application/team.service';

/**
 * Teams (a lead and members per office) and the Archive (owner request,
 * 2026-09-29). Any officer may read these (the /staff/ prefix already admits
 * staff only; an Administrator holds no `applications:read` and still needs
 * the Archive). Who may assign, archive or restore is decided by the
 * services, which say why not.
 */

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

function callerOf(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

/** The step guard's refusal as a problem: whose step it is, or whose application. */
export function stepRefused(check: Exclude<StepCheck, { ok: true }>): never {
  if (check.reason === 'not-found') throw ProblemException.notFound(check.detail);
  throw new ProblemException(
    ProblemType.forbidden,
    check.reason === 'assigned-to-other' ? 'Assigned to someone else' : check.reason === 'view-only' ? 'View only' : 'Not your stage',
    HttpStatus.FORBIDDEN, check.detail, undefined, { reason: check.reason },
  );
}

function archiveRefused(outcome: Exclude<ArchiveOutcome, { ok: true }>): never {
  if (outcome.reason === 'not-found') throw ProblemException.notFound(outcome.detail);
  if (outcome.reason === 'not-permitted') {
    throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, outcome.detail);
  }
  if (outcome.reason === 'reason-required') {
    throw ProblemException.validation([{ pointer: '/reason', message: outcome.detail }]);
  }
  throw new ProblemException(
    ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
    outcome.detail, undefined, { reason: outcome.reason },
  );
}

const assignShape = z.object({ assigneeId: z.string().uuid().nullable() }).strict();
const archiveShape = z.object({ reason: z.string().trim().min(1, 'required').max(500) }).strict();
const kindShape = z.enum(ARCHIVE_KINDS as [ArchiveKind, ...ArchiveKind[]]);

@Controller('staff')
export class StaffTeamsController {
  constructor(
    private readonly teams: TeamService,
    private readonly archives: ArchiveService,
  ) {}

  private async mayArchive(request: AuthenticatedRequest): Promise<void> {
    if (!(await this.archives.handlesAny(callerOf(request)))) {
      throw new ProblemException(
        ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN,
        'Your position cannot archive or restore records. You can still open the Archive to see what is in it.',
      );
    }
  }

  /** Every team: its lead and members, and the work waiting on it. */
  @Get('teams')
  async overview(): Promise<Record<string, unknown>> {
    return { data: await this.teams.overview() };
  }

  /**
   * Who an application is with, within the team whose step it is at. A lead
   * gives it to a member (or takes it back to unassigned); a member takes an
   * unassigned one, or hands theirs back.
   */
  @Post('applications/:applicationId/assignment')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('applications:read')
  async assign(
    @Req() request: AuthenticatedRequest, @Param('applicationId') applicationId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const outright = await this.teams.refusesOutright(callerOf(request));
    if (outright !== null) throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, outright);
    const input = parse(assignShape, body);
    const result = await this.teams.assign({ caller: callerOf(request), applicationId, assigneeId: input.assigneeId });
    if (!result.ok) {
      if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
      throw new ProblemException(
        result.reason === 'not-permitted' ? ProblemType.forbidden : ProblemType.conflict,
        result.reason === 'not-permitted' ? 'Not permitted' : 'The application cannot be assigned that way',
        result.reason === 'not-permitted' ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT,
        result.detail, undefined, { reason: result.reason },
      );
    }
    return { assignee: result.assignee, detail: result.detail };
  }

  /** Everything archived, of every kind, with whether the caller may restore each. */
  @Get('archive')
  async archived(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return { data: await this.archives.list(callerOf(request)) };
  }

  /** Archives a citizen account or a business, with the reason. */
  @Post('archive/:kind/:id')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Req() request: AuthenticatedRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    await this.mayArchive(request);
    const which = parse(z.enum(['citizen', 'business']), kind);
    const input = parse(archiveShape, body);
    const outcome = await this.archives.archive({ caller: callerOf(request), kind: which, id, reason: input.reason });
    if (!outcome.ok) archiveRefused(outcome);
    return { detail: outcome.detail };
  }

  /** Restores any archived item. */
  @Post('archive/:kind/:id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Req() request: AuthenticatedRequest, @Param('kind') kind: string, @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    await this.mayArchive(request);
    const which = parse(kindShape, kind);
    const outcome = await this.archives.restore({ caller: callerOf(request), kind: which, id });
    if (!outcome.ok) archiveRefused(outcome);
    return { detail: outcome.detail };
  }
}
