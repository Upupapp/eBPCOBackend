import { Controller, Get, HttpStatus, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import {
  EVALUATION_RESULTS, EVALUATION_STAGES, EvaluationService,
} from '../application/evaluation.service';

/**
 * The evaluator's worklist.
 *
 * Its own controller, and that is not cosmetic. This route was first written as
 * `@Get('/staff/evaluations')` inside `@Controller('staff/applications')`, where
 * the leading slash does NOT escape the prefix — it registered
 * `/staff/applications/staff/evaluations` and 404'd. The same trap put an
 * onsite-payment route under the wrong prefix earlier in this codebase, which
 * is why the fix is a prefix that matches the path rather than a cleverer
 * string.
 */

const queryShape = z.object({
  stage: z.enum(EVALUATION_STAGES).optional(),
  result: z.enum(EVALUATION_RESULTS).optional(),
  // `mine` in the portal's language: applications this officer has already
  // recorded something against, not ones assigned to them — nothing in this
  // service assigns work to a named officer, and pretending otherwise would be
  // a queue that silently shows everyone the same rows.
  evaluatedByMe: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
}).strict();

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

@Controller('staff/evaluations')
export class StaffEvaluationsController {
  constructor(private readonly evaluations: EvaluationService) {}

  @Get()
  @RequireScopes('applications:read')
  async queue(
    @Req() request: AuthenticatedRequest, @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(queryShape, query ?? {});
    const page = await this.evaluations.queue(callerOf(request), {
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.evaluatedByMe === undefined ? {} : { evaluatedByMe: input.evaluatedByMe }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return { items: page.rows, nextCursor: page.nextCursor };
  }
}
