import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import { StaffQueueService } from '../application/staff-queue.service';
import { EVALUATION_RESULTS, EVALUATION_STAGES, EvaluationService } from '../application/evaluation.service';
import { AssessmentService } from '../../payments/application/assessment.service';
import { PermitService } from '../../permits/application/permit.service';

/**
 * The things an officer DOES to an application, as opposed to reading it.
 *
 * Separate from the queue controller because these are the operations that
 * change the record, and every one of them is scope-gated by the specific duty
 * it belongs to: an evaluator cannot issue an Order of Payment, an assessor
 * cannot generate a permit. That separation is the point of the role table, and
 * putting reads and writes in one class makes it easy to widen a scope for a
 * read and quietly widen it for a write.
 *
 * Each route first asks the queue service whether this caller may see the
 * application at all. Not-yours and not-there answer alike, for the same reason
 * as everywhere else: telling an officer that a reference exists but is not
 * theirs confirms a neighbour has applied for a permit.
 */

const evaluationShape = z.object({
  stage: z.enum(EVALUATION_STAGES),
  result: z.enum(EVALUATION_RESULTS),
  remarks: z.string().max(4000).optional(),
});

const orderOfPaymentShape = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
});

const permitShape = z.object({
  scope: z.string().min(1).max(2000),
  conditions: z.array(z.string().max(1000)).max(50).optional(),
});

const preparationShape = z.object({
  claimLocation: z.string().min(1).max(400),
  officeHours: z.string().min(1).max(200),
  bringWithYou: z.array(z.string().max(300)).max(20).optional(),
});

const releaseShape = z.object({
  claimantName: z.string().min(1).max(200),
  method: z.enum(['Physical Claim', 'Authorized Representative']),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
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

function callerOf(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

/**
 * A refused action, as the officer needs to hear it.
 *
 * `422` rather than `409` for most of these: the request was well formed and
 * the caller was entitled to make it, but something about the application is
 * not yet true. That is a step to take, not a mistake to correct, and the two
 * send an officer to different places. The service's own `detail` is used
 * verbatim, because it knows which stage is next and which status the
 * application is actually in.
 */
function refusal(reason: string, detail: string): ProblemException {
  const status = reason === 'not-found'
    ? HttpStatus.NOT_FOUND
    : reason === 'self-review' || reason === 'self-verification'
      ? HttpStatus.FORBIDDEN
      : reason === 'already-decided' || reason === 'already-generated'
        || reason === 'already-released' || reason === 'already-assessed'
        || reason === 'already-verified' || reason === 'conflict'
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;

  const type = status === HttpStatus.NOT_FOUND
    ? ProblemType.notFound
    : status === HttpStatus.FORBIDDEN
      ? ProblemType.forbidden
      : status === HttpStatus.CONFLICT
        ? ProblemType.conflict
        : ProblemType.unprocessable;

  const title = status === HttpStatus.NOT_FOUND
    ? 'No such resource'
    : status === HttpStatus.FORBIDDEN
      ? 'Not permitted'
      : status === HttpStatus.CONFLICT
        ? 'The resource is not in a state that permits this'
        : 'A precondition is unmet';

  return new ProblemException(type, title, status, detail);
}

@Controller('staff/applications/:applicationId')
export class StaffActionsController {
  constructor(
    private readonly queue: StaffQueueService,
    private readonly evaluations: EvaluationService,
    private readonly assessment: AssessmentService,
    private readonly permits: PermitService,
  ) {}

  /** Readable and actionable are different questions; this answers the first. */
  private async visible(caller: Caller, applicationId: string): Promise<void> {
    if (await this.queue.detail(caller, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }
  }

  @Post('evaluations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:evaluate')
  async evaluate(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(evaluationShape, body);
    await this.visible(caller, applicationId);

    const result = await this.evaluations.record({
      applicationId,
      stage: input.stage,
      result: input.result,
      evaluator: caller,
      ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    // `complete` is returned so the portal knows whether the application can now
    // be assessed, without a second request that would race the first.
    return { evaluationId: result.evaluationId, evaluationsComplete: result.complete };
  }

  @Post('order-of-payment')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:assess')
  async assess(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(orderOfPaymentShape, body ?? {});
    await this.visible(caller, applicationId);

    const result = await this.assessment.issue({
      applicationId,
      officer: caller,
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    return { orderId: result.orderId, number: result.number, totalCentavos: result.total };
  }

  @Post('permit')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:approve')
  async generatePermit(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(permitShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.generate({
      applicationId, officer: caller, scope: input.scope, conditions: input.conditions ?? [],
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    return { permitNumber: result.permitNumber, issuedDate: result.issuedDate };
  }

  @Post('release-preparation')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:release')
  async prepareRelease(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(preparationShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.prepareRelease({
      applicationId, officer: caller,
      claimLocation: input.claimLocation, officeHours: input.officeHours,
      bringWithYou: input.bringWithYou ?? [],
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    return { prepared: true };
  }

  @Post('release')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:release')
  async release(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(releaseShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.release({
      applicationId, officer: caller, claimantName: input.claimantName, method: input.method,
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    return { releasedAt: result.releasedAt };
  }
}
