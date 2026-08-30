import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../../applications/domain/application';
import { FEE_LINES } from '../domain/order-of-payment';
import { FeeConfigService } from '../application/fee-config.service';

/**
 * What the LGU charges, and how it will accept the money.
 *
 * Both are `staff:administer`, not `staff:assess`. Setting a fee is not the
 * same job as computing one: an assessor applies the published schedule to an
 * application, and changing the schedule itself changes what every future
 * applicant is charged. An officer who could do both could quietly assess a
 * fee that suits them and publish an ordinance figure to match.
 *
 * PUBLISH, not PUT. A schedule in force is never edited — see the service for
 * why the version an assessment cites has to keep meaning what it meant.
 */

const entryShape = z.object({
  permitType: z.string().min(1).max(80),
  line: z.enum(FEE_LINES),
  amountCentavos: z.number().int().min(0).max(1_000_000_000),
  basis: z.string().min(1, 'name the ordinance or issuance this rests on').max(400),
}).strict();

const publishShape = z.object({
  version: z.string().min(1).max(40),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  publishedBy: z.string().min(1, 'name the ordinance or issuance that authorises it').max(200),
  entries: z.array(entryShape).min(1).max(500),
}).strict();

const methodShape = z.object({
  active: z.boolean().optional(),
  label: z.string().min(1).max(80).optional(),
  instructions: z.string().max(2000).optional(),
}).strict().refine(
  (value) => value.active !== undefined || value.label !== undefined || value.instructions !== undefined,
  { message: 'give at least one of active, label or instructions' },
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

@Controller('staff/config')
export class StaffFeeConfigController {
  constructor(private readonly config: FeeConfigService) {}

  /**
   * Every version, not only the one in force.
   *
   * An officer explaining a bill from March needs the schedule that applied in
   * March, and each carries a named status so three clients cannot each work
   * out "is this the current one" from two dates and disagree.
   */
  @Get('fee-schedules')
  @RequireScopes('payments:read')
  async schedules(): Promise<Record<string, unknown>> {
    return { data: await this.config.schedules() };
  }

  @Post('fee-schedules')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:administer')
  async publish(
    @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(publishShape, body);
    const result = await this.config.publish({
      version: input.version,
      effectiveFrom: input.effectiveFrom,
      publishedBy: input.publishedBy,
      entries: input.entries,
      officer: callerOf(request),
    });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.unprocessable, 'The schedule could not be published',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { ...result.value };
  }

  @Get('payment-methods')
  @RequireScopes('payments:read')
  async methods(): Promise<Record<string, unknown>> {
    return { data: await this.config.methods() };
  }

  @Put('payment-methods/:method')
  @RequireScopes('staff:administer')
  async setMethod(
    @Req() request: AuthenticatedRequest, @Param('method') method: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(methodShape, body);
    const result = await this.config.setMethod({
      method, officer: callerOf(request),
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    });
    if (!result.ok) {
      if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
      throw new ProblemException(
        ProblemType.unprocessable, 'The payment method could not be changed',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { ...result.value };
  }
}
