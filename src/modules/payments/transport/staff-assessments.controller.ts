import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../../applications/domain/application';
import { FEE_LINES, FeeLine } from '../domain/order-of-payment';
import { AssessmentWorkflowService, WorkflowResult } from '../application/assessment-workflow.service';
import { AssessmentService } from '../application/assessment.service';

/**
 * Preparing an assessment, and having a second officer approve it.
 *
 * Four steps rather than one, because issuing an Order of Payment used to be a
 * single act by a single officer with no review: the schedule was read, six
 * figures computed, and a bill an applicant must pay was written, all under one
 * authority. Every step here carries `staff:assess` EXCEPT approval, which is
 * refused to the officer who prepared it — the separation of duty is between
 * people, not between scopes, so the scope alone cannot express it.
 */

const draftShape = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
  // Asked for explicitly. A revision that a client could start by accident is a
  // second bill for the same permit; refusing unless it is stated makes the
  // dangerous case the deliberate one.
  revision: z.boolean().optional(),
}).strict();

const supersedeShape = z.object({
  reason: z.string().min(10, 'state a reason the applicant can read').max(2000),
}).strict();

const lineShape = z.object({
  amountCentavos: z.number().int().min(0).max(1_000_000_000).optional(),
  included: z.boolean().optional(),
  basis: z.string().max(400).optional(),
}).strict().refine(
  (value) => value.amountCentavos !== undefined || value.included !== undefined || value.basis !== undefined,
  { message: 'give at least one of amountCentavos, included or basis' },
);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`, message: issue.message,
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

/** One mapping for every refusal, so the four routes answer alike. */
function answer(result: WorkflowResult): Record<string, unknown> {
  if (result.ok) return { ...result.assessment };
  if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
  if (result.reason === 'self-approval') {
    // 403 rather than 422: this is not a state the assessment is in, it is an
    // act this caller may not perform. Another officer can perform it right now.
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
    );
  }
  throw new ProblemException(
    ProblemType.unprocessable, 'The assessment could not be changed',
    HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
  );
}

@Controller('staff')
export class StaffAssessmentsController {
  constructor(
    private readonly workflow: AssessmentWorkflowService,
    private readonly assessments: AssessmentService,
  ) {}

  /** Opens a draft, pre-filled from the schedule in force today. */
  @Post('applications/:applicationId/assessments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:assess')
  async draft(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(draftShape, body ?? {});
    return answer(await this.workflow.draft({
      applicationId, officer: callerOf(request),
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    }));
  }

  @Get('assessments/:assessmentId')
  @RequireScopes('payments:read')
  async detail(@Param('assessmentId') assessmentId: string): Promise<Record<string, unknown>> {
    const assessment = await this.workflow.byId(assessmentId);
    if (assessment === null) throw ProblemException.notFound('No such assessment.');
    return { ...assessment };
  }

  /**
   * PUT, not PATCH: the six lines are a fixed set, so this replaces one of them
   * rather than creating anything. A client that repeats the same request twice
   * leaves the line in the same state, which is what an officer at a keyboard
   * with an unreliable connection needs.
   */
  @Put('assessments/:assessmentId/lines/:line')
  @RequireScopes('staff:assess')
  async setLine(
    @Req() request: AuthenticatedRequest,
    @Param('assessmentId') assessmentId: string,
    @Param('line') line: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!(FEE_LINES as readonly string[]).includes(line)) {
      throw ProblemException.notFound(
        `There is no "${line}" fee line. The six are: ${FEE_LINES.join(', ')}.`,
      );
    }
    const input = parse(lineShape, body);
    return answer(await this.workflow.setLine({
      assessmentId, line: line as FeeLine, officer: callerOf(request),
      ...(input.amountCentavos === undefined ? {} : { amountCentavos: input.amountCentavos }),
      ...(input.included === undefined ? {} : { included: input.included }),
      ...(input.basis === undefined ? {} : { basis: input.basis }),
    }));
  }

  @Post('assessments/:assessmentId/submit')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:assess')
  async submit(
    @Req() request: AuthenticatedRequest, @Param('assessmentId') assessmentId: string,
  ): Promise<Record<string, unknown>> {
    return answer(await this.workflow.submit({ assessmentId, officer: callerOf(request) }));
  }

  /**
   * Replaces an Order of Payment in force with one issued from an approved
   * REVISION.
   *
   * The Order is what is superseded, so it is what the path names. The Master
   * Command wrote this as `/staff/assessments/:id/supersede`, which names the
   * wrong resource: an assessment is never superseded, it is issued or it is
   * not, and the thing an applicant is holding is the Order.
   *
   * A correction is a new Order, never an edit. The reason is required because
   * an applicant whose bill changed is owed an explanation, and the reason
   * recorded against the replacement is the only place it can live.
   */
  @Post('orders-of-payment/:orderId/supersede')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:assess')
  async supersede(
    @Req() request: AuthenticatedRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(supersedeShape, body);
    const result = await this.assessments.supersede({
      orderId, reason: input.reason, officer: callerOf(request),
    });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.unprocessable, 'The Order of Payment could not be superseded',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { orderId: result.orderId, number: result.number, totalCentavos: result.total };
  }

  @Post('assessments/:assessmentId/approve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:assess')
  async approve(
    @Req() request: AuthenticatedRequest, @Param('assessmentId') assessmentId: string,
  ): Promise<Record<string, unknown>> {
    return answer(await this.workflow.approve({ assessmentId, officer: callerOf(request) }));
  }
}
