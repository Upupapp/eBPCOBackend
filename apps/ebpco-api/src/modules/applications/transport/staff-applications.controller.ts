import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { LIFECYCLE_STATUSES } from '../domain/lifecycle';
import { refusalToProblem } from './refusal-to-problem';
import { Caller } from '../domain/application';
import { LifecycleService } from '../application/lifecycle.service';
import { StaffQueueService } from '../application/staff-queue.service';
import { SubmissionService } from '../application/submission.service';
import { CASTILLA_BARANGAYS } from '../../businesses/castilla-barangays';
import { EditableFields, RecordsService } from '../application/records.service';
import { NotesService } from '../application/notes.service';
import { ProfilePhotoService } from '../../identity/application/profile-photo.service';

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
    /** Kept on a new applicant record (migration 036), same as self-service sign-up; not part of the returning-name check. */
    middleName: z.string().max(80).optional(),
    lastName: z.string().min(1).max(80),
    // Required, and the schema is why: `applicants.account_id` is NOT NULL and
    // an account needs a unique address. A walk-in with no email cannot be
    // filed for until that constraint changes — which is a schema decision.
    email: z.string().email().max(320),
    mobileNumber: z.string().min(7).max(20).optional(),
    /**
     * The applicant's OWN address (migration 036) — where the office writes
     * to them, distinct from the business's address below. The intake form
     * asked for it and then dropped it; now it is kept on a NEW applicant
     * record. An existing applicant's address is theirs to change.
     */
    street: z.string().max(200).optional(),
    barangay: z.string().max(120).optional(),
  }).strict(),
  // One or the other, never both: `business` registers a new one, `businessId`
  // names an existing one already owned by this applicant.
  business: z.object({
    name: z.string().min(1).max(200),
    // The real, current `businesses.category` vocabulary (migration 041) —
    // this had drifted to an older six-value list missing
    // Construction/Transport/Agriculture, so an officer assisting a walk-in
    // citizen who wanted exactly one of those three could never file it.
    category: z.enum([
      'Retail', 'Food Service', 'Services', 'Manufacturing',
      'Construction', 'Transport', 'Agriculture', 'Other',
    ]),
    street: z.string().min(1).max(200),
    barangay: z.enum(CASTILLA_BARANGAYS),
    city: z.string().min(1).max(120),
    province: z.string().min(1).max(120),
    registrationNumber: z.string().min(1).max(60),
    dateRegistered: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  }).strict().optional(),
  businessId: z.string().uuid().optional(),
  permitType: z.string().min(1).max(80),
  applicationAction: z.enum(['New', 'Renewal', 'Amendment']),
  renewsPermitNumber: z.string().min(1).max(60).nullable().optional(),
  /** The permit this renews, when it predates eBPCO and so is not on file. Self-reported, never verified; use this or renewsPermitNumber, never both. */
  priorPermitClaim: z.string().min(1).max(60).nullable().optional(),
  location: z.string().max(400).optional(),
  form: z.record(z.string(), z.unknown()).optional(),
  /** Files at Draft instead of Submitted — see Submission.saveAsDraft's own doc comment. */
  saveAsDraft: z.boolean().optional(),
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
  // Resent together with applicationAction, always — see EditableFields'
  // own doc comment. Either without the other is refused by the service,
  // not silently ignored here.
  renewsPermitNumber: z.string().min(1).max(80).nullable().optional(),
  priorPermitClaim: z.string().min(1).max(80).nullable().optional(),
}).strict();

const noteShape = z.object({
  body: z.string().min(1).max(4000),
  parentNoteId: z.string().uuid().nullable().optional(),
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
    private readonly notes: NotesService,
    private readonly photos: ProfilePhotoService,
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
        middleName: input.applicant.middleName?.trim() || null,
        lastName: input.applicant.lastName,
        email: input.applicant.email,
        mobileNumber: input.applicant.mobileNumber ?? null,
        street: input.applicant.street?.trim() || null,
        barangay: input.applicant.barangay?.trim() || null,
      },
      business: input.business ?? null,
      businessId: input.businessId ?? null,
      renewsPermitNumber: input.renewsPermitNumber ?? null,
      priorPermitClaim: input.priorPermitClaim ?? null,
      submission: {
        permitType: input.permitType,
        applicationAction: input.applicationAction,
        location: input.location ?? null,
        form: input.form ?? {},
      },
      saveAsDraft: input.saveAsDraft ?? false,
      idempotencyKey: key,
    });

    if (!result.ok) {
      if (result.reason === 'key-reused') {
        throw new ProblemException(
          ProblemType.conflict, 'That key was used for a different request',
          HttpStatus.CONFLICT, result.detail,
        );
      }
      if (result.reason === 'name-mismatch') {
        // 409, not 422: the request is well-formed and the applicant may well
        // be real — the state that conflicts is an EXISTING account under
        // that address with a different name on it, and the officer has to
        // decide which of the two facts is wrong before anything is filed.
        throw new ProblemException(
          ProblemType.conflict, 'That email address belongs to a different applicant',
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
      /**
       * Whether the address already had an account, so the officer is told
       * the application was filed under the existing record (same name —
       * a different name is refused above) rather than a new one.
       */
      returningApplicant: result.returningApplicant,
      /** Whether the address is now confirmed — by a code the applicant just read back at the counter, or previously. */
      emailVerified: result.emailVerified,
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
      ...(parsed.renewsPermitNumber === undefined ? {} : { renewsPermitNumber: parsed.renewsPermitNumber }),
      ...(parsed.priorPermitClaim === undefined ? {} : { priorPermitClaim: parsed.priorPermitClaim }),
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

  /**
   * The applicant's own profile photo, for the officer looking at their
   * application. Until now the only reader was the citizen themself
   * (`GET /me/photo`), so a photo a citizen set was invisible to every staff
   * screen — the Admin Portal drew initials for everyone. Same bytes, same
   * headers as the citizen's own route: `inline`, `nosniff`, never cached.
   *
   * Gated by the same visibility check as the detail route, and by
   * `applications:read` — an officer who may open the application may see
   * who filed it. 404 both when the application is not visible and when the
   * account has no photo, so the response does not distinguish the two.
   */
  @Get(':applicationId/applicant-photo')
  @RequireScopes('applications:read')
  async applicantPhoto(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    if (await this.queue.detail(callerOf(request), applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }
    const accountId = await this.queue.applicantAccountId(applicationId);
    const stored = accountId === null ? null : await this.photos.photoFor(accountId);
    if (stored === null) throw ProblemException.notFound('No photo on file.');

    void reply
      .header('content-disposition', 'inline')
      .header('content-type', stored.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return stored.bytes;
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
   * Internal staff notes — a workspace for the office to leave each other
   * context, never shown to the applicant. `applications:read`, the same
   * scope `detail` above requires: any staff role that can open this
   * application at all can read what colleagues have already written on it.
   */
  @Get(':applicationId/notes')
  @RequireScopes('applications:read')
  async listNotes(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ): Promise<Record<string, unknown>> {
    if (await this.queue.detail(callerOf(request), applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }
    return { notes: await this.notes.listFor(applicationId) };
  }

  /**
   * Adding one. `staff:annotate`, not `applications:read` — every ACTING role
   * that holds `applications:read` also held this route until 2026-09-19,
   * which included `auditor`. That role's entire definition is oversight
   * WITHOUT authority (see `account.ts`), and a read scope authorising a
   * write grants that write to everyone holding it — the exact failure mode
   * `staff:receive` was added to close, on the same file, a page above. Nor
   * is it `applications:write` (records-officer/super-admin only): this is a
   * colleague-to-colleague annotation, not a change to the application
   * record, and every acting role but the auditor should be able to leave
   * one.
   */
  @Post(':applicationId/notes')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:annotate')
  async addNote(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    if (await this.queue.detail(caller, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }
    const input = parse(noteShape, body);
    const result = await this.notes.create({
      applicationId, body: input.body, parentNoteId: input.parentNoteId ?? null, caller,
    });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.unprocessable, 'The note could not be saved',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    return { note: result.note };
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

// `refusalToProblem` moved to `./refusal-to-problem.ts` — the citizen-facing
// controller needs the exact same translation for its own cancel/submit-draft
// routes, and a domain-error-to-HTTP-problem mapping has nothing staff-specific
// in it to justify two copies.
