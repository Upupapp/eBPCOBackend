import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { LIFECYCLE_STATUSES } from '../domain/lifecycle';
import { PRECONDITION_MESSAGE, PROBLEM_TYPE, Refusal } from '../domain/lifecycle-errors';
import { Caller } from '../domain/application';
import { LifecycleService } from '../application/lifecycle.service';
import { StaffQueueService } from '../application/staff-queue.service';
import { SubmissionService } from '../application/submission.service';
import { EditableFields, RecordsService } from '../application/records.service';

/**
 * The officer's surface.
 *
 * Separate from the applicant's routes rather than the same routes behaving
 * differently by caller kind. One path that returns an officer's view or an
 * applicant's view depending on a token claim is one mistake away from serving
 * the wrong one, and the mistake is invisible in a URL. `/staff/...` is a
 * different path, so a misrouted request 404s instead of over-disclosing.
 *
 * Every route is scope-gated. The guard is deny-by-default, so a route added
 * here without a scope is authenticated-only rather than open — still tighter
 * than it should be, which is why each one names its scope explicitly.
 */

const statusEnum = z.enum(LIFECYCLE_STATUSES);

const queryShape = z.object({
  status: z.union([statusEnum, z.array(statusEnum)]).optional(),
  permitType: z.string().min(1).max(80).optional(),
  q: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(400).optional(),
});

const transitionShape = z.object({
  to: statusEnum,
  /**
   * The version the officer was looking at. Optional in the schema and
   * strongly encouraged in practice: without it two officers acting on one
   * application produce a last-write-wins, and the loser never learns their
   * decision was discarded.
   */
  expectedVersion: z.number().int().min(1).optional(),
  remarks: z.string().min(1).max(2000).optional(),
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

/**
 * The caller, as the domain understands it.
 *
 * Throws rather than returning a nullable, because a request that reached a
 * guarded handler without claims is a wiring fault, not a client error, and
 * returning an empty caller would silently apply the "no visible statuses"
 * path and look like an empty queue.
 */
function callerOf(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(
      ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED,
    );
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

const onBehalfShape = z.object({
  applicant: z.object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    // Required, and the schema is why: `applicants.account_id` is NOT NULL and
    // an account needs a unique address. A walk-in with no email cannot be
    // filed for until that constraint changes — which is a schema decision.
    email: z.string().email().max(320),
    mobileNumber: z.string().min(7).max(20).optional(),
  }).strict(),
  // One or the other, never both: `business` registers a new one, `businessId`
  // names an existing one already owned by this applicant.
  business: z.object({
    name: z.string().min(1).max(200),
    category: z.enum(['Retail', 'Food Service', 'Services', 'Manufacturing', 'Wholesale', 'Other']),
    street: z.string().min(1).max(200),
    barangay: z.string().min(1).max(120),
    city: z.string().min(1).max(120),
    province: z.string().min(1).max(120),
    registrationNumber: z.string().min(1).max(60),
    dateRegistered: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  }).strict().optional(),
  businessId: z.string().uuid().optional(),
  permitType: z.string().min(1).max(80),
  applicationAction: z.enum(['New', 'Renewal', 'Amendment']),
  location: z.string().max(400).optional(),
  form: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => !(value.business !== undefined && value.businessId !== undefined), {
  message: 'give either business or businessId, not both',
  path: ['business'],
});

const patchShape = z.object({
  location: z.string().max(400).nullable().optional(),
  permitType: z.string().min(1).max(80).optional(),
  applicationAction: z.enum(['New', 'Renewal', 'Amendment']).optional(),
  businessId: z.string().uuid().nullable().optional(),
  form: z.record(z.string(), z.unknown()).optional(),
}).strict();

const archiveShape = z.object({
  applicationIds: z.array(z.string().uuid()).min(1).max(200),
  // Required, not optional. Remarks are how the next officer learns why a
  // record was put away, and an archive nobody can explain is indistinguishable
  // from one made by mistake.
  remarks: z.string().min(3, 'say why these are being archived').max(2000),
}).strict();

@Controller('staff/applications')
export class StaffApplicationsController {
  constructor(
    private readonly queue: StaffQueueService,
    private readonly lifecycle: LifecycleService,
    private readonly submissions: SubmissionService,
    private readonly records: RecordsService,
  ) {}

  @Get()
  @RequireScopes('applications:read')
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(queryShape, query ?? {});
    const statuses = input.status === undefined
      ? undefined
      : (Array.isArray(input.status) ? input.status : [input.status]);

    const page = await this.queue.page(callerOf(request), {
      ...(statuses === undefined ? {} : { statuses }),
      ...(input.permitType === undefined ? {} : { permitType: input.permitType }),
      ...(input.q === undefined ? {} : { search: input.q }),
      ...(input.from === undefined ? {} : { submittedFrom: new Date(input.from) }),
      ...(input.to === undefined ? {} : { submittedTo: new Date(input.to) }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });

    return { items: page.rows, nextCursor: page.nextCursor };
  }

  /**
   * Filing for a walk-in, at the counter.
   *
   * `applications:write` and `kind === 'staff'` — the second comes from the
   * guard, which refuses every `/staff` path to a non-staff token. Held by the
   * records officer, whose job is maintenance of the record, which is what this
   * is: the LGU entering a filing it received on paper.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('applications:write')
  async fileOnBehalf(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const input = parse(onBehalfShape, body);
    // Required, as on the self-service path: an officer at a counter whose
    // response is lost retries, and a second permit application for the same
    // walk-in is a second reference number the LGU has to explain.
    const key = parse(z.string().uuid('must be a UUID'), idempotencyKey ?? null);

    const result = await this.submissions.fileOnBehalf({
      caller: callerOf(request),
      applicant: {
        firstName: input.applicant.firstName,
        lastName: input.applicant.lastName,
        email: input.applicant.email,
        mobileNumber: input.applicant.mobileNumber ?? null,
      },
      business: input.business ?? null,
      businessId: input.businessId ?? null,
      submission: {
        permitType: input.permitType,
        applicationAction: input.applicationAction,
        location: input.location ?? null,
        form: input.form ?? {},
      },
      idempotencyKey: key,
    });

    if (!result.ok) {
      if (result.reason === 'key-reused') {
        throw new ProblemException(
          ProblemType.conflict, 'That key was used for a different request',
          HttpStatus.CONFLICT, result.detail,
        );
      }
      throw new ProblemException(
        ProblemType.unprocessable, 'The filing could not be accepted',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }

    return {
      applicationId: result.applicationId,
      referenceNumber: result.referenceNumber,
      applicantId: result.applicantId,
      // Said plainly, because the officer is standing in front of the person it
      // concerns: nothing has been emailed, and the applicant cannot sign in
      // until they set a password through account recovery.
      applicantNextStep:
        'The applicant sets a password through account recovery before they can track this online.',
    };
  }

  /**
   * Archiving, which is NOT cancelling.
   *
   * Declared before `:applicationId` for the same reason `metrics` is: Nest
   * matches in declaration order and "archive" is a valid-looking id.
   */
  @Post('archive')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('applications:write')
  async archive(
    @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(archiveShape, body);
    const result = await this.records.archive({
      applicationIds: input.applicationIds, remarks: input.remarks, caller: callerOf(request),
    });
    if (!result.ok) {
      throw new ProblemException(
        result.reason === 'not-found' ? ProblemType.notFound : ProblemType.unprocessable,
        result.reason === 'not-found' ? 'No such resource' : 'The archive could not be completed',
        result.reason === 'not-found' ? HttpStatus.NOT_FOUND : HttpStatus.UNPROCESSABLE_ENTITY,
        result.detail,
      );
    }
    return { archived: result.archived };
  }

  /**
   * Correcting a filed application.
   *
   * A named list of fields, never `Partial<the whole row>`: the portal's own
   * store offers the latter, which would let a client set `lifecycleStatus`
   * directly and route around the transition table.
   */
  @Patch(':applicationId')
  @RequireScopes('applications:write')
  async edit(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = parse(patchShape, body);
    // Spread only the keys that are present. Under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and passing one
    // through would make "field omitted" indistinguishable from "field cleared".
    const patch: EditableFields = {
      ...(parsed.location === undefined ? {} : { location: parsed.location }),
      ...(parsed.permitType === undefined ? {} : { permitType: parsed.permitType }),
      ...(parsed.applicationAction === undefined ? {} : { applicationAction: parsed.applicationAction }),
      ...(parsed.businessId === undefined ? {} : { businessId: parsed.businessId }),
      ...(parsed.form === undefined ? {} : { form: parsed.form }),
    };
    const result = await this.records.edit({
      applicationId, patch, caller: callerOf(request),
    });
    if (!result.ok) {
      if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
      throw new ProblemException(
        ProblemType.unprocessable, 'The edit could not be accepted',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { changed: result.changed };
  }

  /**
   * Declared before `:applicationId`, because Nest matches in declaration order
   * and "metrics" is a valid-looking path segment. Registered the other way
   * round, a dashboard request becomes a lookup for an application called
   * "metrics" and 404s.
   */
  @Get('metrics')
  @RequireScopes('applications:read')
  async metrics(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const metrics = await this.queue.metrics(callerOf(request));
    return { ...metrics };
  }

  @Get(':applicationId')
  @RequireScopes('applications:read')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<Record<string, unknown>> {
    const detail = await this.queue.detail(callerOf(request), applicationId);
    if (detail === null) throw ProblemException.notFound('No such application.');
    return { ...detail };
  }

  /**
   * A status change, decided by the lifecycle engine.
   *
   * POST to a sub-resource rather than PATCH of a `status` field. A permit
   * moving from Assessed to Payment Verified is an event with preconditions,
   * an actor and consequences, not a field assignment — and a PATCH invites a
   * client to think it may set any value it can spell.
   */
  @Post(':applicationId/transitions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('applications:read')
  async transition(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(transitionShape, body);

    // Required here, optional in the domain. `expectedVersion` answers "has
    // anyone else changed this since I looked"; this answers "did MY request
    // already happen", and they are different questions. Without it, an officer
    // whose successful request lost its response retries and is told someone
    // else changed the application -- untrue, and in a permit office a question
    // about who did what.
    const key = parse(z.string().uuid('must be a UUID'), idempotencyKey ?? null);

    // Readable and actionable are different questions. The row filter decides
    // whether this officer may see the application at all; the lifecycle engine
    // decides whether they may move it, and answers with the specific reason.
    if (await this.queue.detail(caller, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }

    const result = await this.lifecycle.transition({
      applicationId,
      caller,
      to: input.to,
      idempotencyKey: key,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    });

    if (result.ok) return { status: result.status, version: result.version };
    if ('reused' in result) {
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }
    throw refusalToProblem(result.refusal);
  }
}

/**
 * A refusal, translated without losing which kind it was.
 *
 * The distinction matters to the officer standing at the counter: "you may not
 * do this", "this application is not ready for that yet", and "someone else
 * changed it while you were reading" require three different next actions, and
 * collapsing them into one 400 makes all three look like a bug in the app.
 *
 * The problem type and the plain-language text come from the domain's own
 * tables rather than from strings written here. A second wording of "you have
 * not paid yet" is a second thing to keep in step with the first, and the one
 * that drifts is always the one the applicant reads.
 */
function refusalToProblem(refusal: Refusal): ProblemException {
  switch (refusal.kind) {
    case 'not-permitted':
      return new ProblemException(
        PROBLEM_TYPE['not-permitted'], 'Not permitted', HttpStatus.FORBIDDEN,
        refusal.reason === 'wrong-actor'
          ? 'This move is not one this kind of account may make.'
          : 'This account does not hold the permission this action requires.',
      );

    case 'illegal-transition':
      return new ProblemException(
        PROBLEM_TYPE['illegal-transition'],
        'The resource is not in a state that permits this',
        HttpStatus.CONFLICT,
        refusal.legalMoves.length === 0
          ? `${refusal.from} is a final status; nothing follows it.`
          : `An application at ${refusal.from} cannot move to ${refusal.to}. It can move to: ${refusal.legalMoves.join(', ')}.`,
      );

    case 'precondition-unmet':
      // Every unmet precondition, not the first. An officer told to fix one
      // thing, who fixes it and is then told about the next, learns to distrust
      // the message.
      return new ProblemException(
        PROBLEM_TYPE['precondition-unmet'], 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
        refusal.unmet.map((precondition) => PRECONDITION_MESSAGE[precondition]).join(' '),
      );

    case 'stale-version':
      return new ProblemException(
        PROBLEM_TYPE['stale-version'], 'The resource has changed', HttpStatus.PRECONDITION_FAILED,
        'Someone else changed this application while it was open. Reload it and look again before acting: '
        + 'the decision you were about to make may no longer be the right one.',
      );
  }
}
