import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import { RequirementsService } from '../application/requirements.service';

/**
 * The checklist a permit type asks for.
 *
 * Two routes over one list, because two populations need it for opposite
 * reasons: an applicant needs to know what to bring BEFORE they file, and an
 * administrator needs to change it. A checklist only the LGU can read is a
 * checklist an applicant discovers by being turned away at a counter.
 */

const documentShape = z.object({
  code: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  description: z.string().max(1000).default(''),
  required: z.boolean(),
}).strict();

const replaceShape = z.object({
  documents: z.array(documentShape).max(60),
}).strict();

/**
 * Which action's checklist. Optional everywhere: every permit type but
 * Building Permit has never distinguished by action, and omitting this
 * still returns their (action-independent) checklist unchanged — see
 * `RequirementsService.forPermitType`'s own doc comment for what omitting
 * it means for Building Permit itself.
 */
const applicationActionShape = z.enum(['New', 'Renewal', 'Amendment']).optional();

function parseApplicationAction(value: unknown): 'New' | 'Renewal' | 'Amendment' | undefined {
  const result = applicationActionShape.safeParse(value === '' ? undefined : value);
  if (!result.success) {
    throw ProblemException.validation([{
      pointer: '/applicationAction',
      message: 'Must be "New", "Renewal", or "Amendment" if given.',
    }]);
  }
  return result.data;
}

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

@Controller()
export class RequirementsController {
  constructor(private readonly requirements: RequirementsService) {}

  /**
   * The applicant's copy. `applications:read`, which every applicant holds —
   * not public, because it is the LGU's operational reference data and nothing
   * about it needs to be readable by someone with no account.
   */
  @Get('requirements/:permitType')
  @RequireScopes('applications:read')
  async forApplicant(
    @Param('permitType') permitType: string,
    @Query('applicationAction') applicationActionParam?: string,
  ): Promise<Record<string, unknown>> {
    const applicationAction = parseApplicationAction(applicationActionParam);
    return {
      permitType, applicationAction: applicationAction ?? null,
      documents: await this.requirements.forPermitType(permitType, applicationAction),
    };
  }

  @Get('staff/config/requirements/:permitType')
  @RequireScopes('applications:read')
  async forStaff(
    @Param('permitType') permitType: string,
    @Query('applicationAction') applicationActionParam?: string,
  ): Promise<Record<string, unknown>> {
    const applicationAction = parseApplicationAction(applicationActionParam);
    return {
      permitType, applicationAction: applicationAction ?? null,
      documents: await this.requirements.forPermitType(permitType, applicationAction),
    };
  }

  /**
   * Replaces the whole checklist. `staff:administer`, not `applications:write`:
   * deciding what every future applicant must bring is a different job from
   * handling one application, and the officers who do the second should not be
   * able to change the rules of the first.
   */
  @Put('staff/config/requirements/:permitType')
  @RequireScopes('staff:administer')
  async replace(
    @Req() request: AuthenticatedRequest,
    @Param('permitType') permitType: string,
    @Body() body: unknown,
    @Query('applicationAction') applicationActionParam?: string,
  ): Promise<Record<string, unknown>> {
    const input = parse(replaceShape, body);
    const applicationAction = parseApplicationAction(applicationActionParam);
    const result = await this.requirements.replace({
      permitType,
      // Spread rather than `applicationAction: applicationAction` — under
      // `exactOptionalPropertyTypes`, an optional property may be ABSENT or
      // hold a value, never explicitly `undefined`; omitted here is not the
      // same as an omitted query param.
      ...(applicationAction === undefined ? {} : { applicationAction }),
      officer: callerOf(request),
      // `.default('')` leaves the type optional under exactOptionalPropertyTypes
      // even though a value is always produced, so the absent case is closed
      // here rather than widened in the domain.
      documents: input.documents.map((document) => ({ ...document, description: document.description ?? '' })),
    });
    if (!result.ok) {
      if (result.reason === 'unknown-permit-type') throw ProblemException.notFound(result.detail);
      throw new ProblemException(
        ProblemType.unprocessable, 'The checklist could not be saved',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { permitType, applicationAction: applicationAction ?? null, documents: result.documents };
  }
}
