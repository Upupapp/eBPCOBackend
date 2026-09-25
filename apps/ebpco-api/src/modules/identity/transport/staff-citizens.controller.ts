import {
  Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import {
  CitizenDirectoryService, CitizenRefusal,
} from '../application/citizen-directory.service';
import { ProfilePhotoService } from '../application/profile-photo.service';
import { CASTILLA_BARANGAYS, CASTILLA_CITY, CASTILLA_PROVINCE } from '../../businesses/castilla-barangays';

/**
 * The Citizens module, over HTTP: `GET /staff/citizens*` for lookup,
 * everything else behind `staff:administer`, mirroring
 * `staff-directory.controller.ts`'s own split between the read scope every
 * front-desk role holds and the write scope only Administrator and Super
 * Admin do.
 *
 * `caller.kind !== 'staff'` is checked on every handler even though the
 * `/staff/` path prefix already refuses a non-staff caller structurally
 * (`AuthenticationGuard`'s own doc comment). Defence in depth, the same
 * posture `staff-businesses.controller.ts` takes on every one of its own
 * handlers — that guard has already leaked once for exactly this class of
 * route.
 */

function reasonShape(): z.ZodObject<{ reason: z.ZodString }> {
  return z.object({ reason: z.string().min(5).max(500) }).strict();
}

const disableShape = reasonShape();
const revokeShape = reasonShape();
const resetLinkShape = reasonShape();

const rectifyShape = z.object({
  reason: z.string().min(5).max(500),
  changes: z.object({
    firstName: z.string().min(1).max(100).optional(),
    middleName: z.string().min(1).max(100).nullable().optional(),
    lastName: z.string().min(1).max(100).optional(),
    mobileNumber: z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'must be 09XXXXXXXXX or +639XXXXXXXXX').optional(),
    street: z.string().min(1).max(200).nullable().optional(),
    barangay: z.enum(CASTILLA_BARANGAYS).nullable().optional(),
    city: z.literal(CASTILLA_CITY).nullable().optional(),
    province: z.literal(CASTILLA_PROVINCE).nullable().optional(),
    postalCode: z.string().regex(/^[0-9]{4}$/, 'a Philippine ZIP is four digits').nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'name at least one field to correct' }),
}).strict();

const eraseShape = z.object({
  reason: z.string().min(5).max(500),
  requestReference: z.string().min(1).max(120),
}).strict();

const listQueryShape = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  verified: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

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

function idempotencyKeyOf(header: string | undefined): string {
  return parse(z.string().uuid('an Idempotency-Key must be a UUID'), header ?? null);
}

/** Mirrors `staff-directory.controller.ts`'s own `actorOf`, for the same reason. */
function actorOf(request: AuthenticatedRequest): { accountId: string; role: string } {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  if (claims.kind !== 'staff') {
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, 'This route serves LGU staff.',
    );
  }
  // The role names on the token, joined — the same shape
  // `staff-directory.controller.ts`'s own `actorOf` records, since a token
  // may hold more than one role and the audit entry should say all of them,
  // not guess at one.
  return { accountId: claims.sub, role: claims.scopes.includes('staff:administer') ? 'staff:administer' : 'staff' };
}

function refuse(refusal: CitizenRefusal | { readonly reason: string; readonly detail: string }): never {
  if (refusal.reason === 'not-found') throw ProblemException.notFound(refusal.detail);
  if (refusal.reason === 'key-reused') {
    throw new ProblemException(ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT, refusal.detail);
  }
  if (refusal.reason === 'no-profile' || refusal.reason === 'staff-account' || refusal.reason === 'erased') {
    throw new ProblemException(ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY, refusal.detail);
  }
  throw new ProblemException(ProblemType.badRequest, 'The request could not be completed', HttpStatus.BAD_REQUEST, refusal.detail);
}

@Controller('staff/citizens')
export class StaffCitizensController {
  constructor(
    private readonly citizens: CitizenDirectoryService,
    private readonly photos: ProfilePhotoService,
  ) {}

  @Get('metrics')
  @RequireScopes('citizens:read')
  async metrics(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    if (request.caller?.kind !== 'staff') {
      throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, 'This route serves LGU staff.');
    }
    return { ...(await this.citizens.metrics()) };
  }

  @Get()
  @RequireScopes('citizens:read')
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<Record<string, unknown>> {
    if (request.caller?.kind !== 'staff') {
      throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, 'This route serves LGU staff.');
    }
    const filters = parse(listQueryShape, query ?? {});
    const result = await this.citizens.list({
      ...(filters.search === undefined ? {} : { search: filters.search }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.verified === undefined ? {} : { verified: filters.verified }),
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 25,
    });
    return { ...result };
  }

  @Get(':citizenId')
  @RequireScopes('citizens:read')
  async detail(
    @Req() request: AuthenticatedRequest, @Param('citizenId') citizenId: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const detail = await this.citizens.detail(citizenId, actor);
    if (detail === null) throw ProblemException.notFound('No such citizen account.');
    return { ...detail };
  }

  /**
   * A citizen's own profile photo, for any staff screen that shows one —
   * the Businesses module's own Contact Person avatar among them. Same
   * bytes/headers as the citizen's own `GET /me/photo` and the identical
   * route on applications (`staff-applications.controller.ts`
   * `applicantPhoto`), scoped here by `citizenId` (`accounts.id`, this
   * module's own id space) rather than by an application, since a business
   * — or a citizen looked up directly — has no application to view it
   * through. 404 both when the account does not exist and when it has no
   * photo, so the response does not distinguish the two.
   */
  @Get(':citizenId/photo')
  @RequireScopes('citizens:read')
  async photo(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    if (request.caller?.kind !== 'staff') {
      throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, 'This route serves LGU staff.');
    }
    if (await this.citizens.byId(citizenId) === null) throw ProblemException.notFound('No such citizen account.');
    const stored = await this.photos.photoFor(citizenId);
    if (stored === null) throw ProblemException.notFound('No photo on file.');

    void reply
      .header('content-disposition', 'inline')
      .header('content-type', stored.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return stored.bytes;
  }

  @Get(':citizenId/sessions')
  @RequireScopes('staff:administer')
  async sessions(
    @Req() request: AuthenticatedRequest, @Param('citizenId') citizenId: string,
  ): Promise<Record<string, unknown>> {
    if (request.caller?.kind !== 'staff') {
      throw new ProblemException(ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, 'This route serves LGU staff.');
    }
    const found = await this.citizens.byId(citizenId);
    if (found === null) throw ProblemException.notFound('No such citizen account.');
    return { data: await this.citizens.sessionsOf(citizenId) };
  }

  @Delete(':citizenId/sessions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async revokeSessions(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(revokeShape, body);
    const result = await this.citizens.revokeAllSessions({
      citizenId, actor, reason: input.reason, idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
    if (!result.ok) refuse(result);
    return { revoked: result.revoked };
  }

  @Post(':citizenId/disable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async disable(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(disableShape, body);
    const result = await this.citizens.setDisabled({
      citizenId, disabled: true, actor, reason: input.reason, idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
    if (!result.ok) refuse(result);
    return { status: 'disabled', reason: input.reason };
  }

  @Post(':citizenId/enable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async enable(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(disableShape, body);
    const result = await this.citizens.setDisabled({
      citizenId, disabled: false, actor, reason: input.reason, idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
    if (!result.ok) refuse(result);
    return { status: 'active', reason: input.reason };
  }

  @Post(':citizenId/password-reset-link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async passwordResetLink(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(resetLinkShape, body);
    const result = await this.citizens.sendPasswordResetLink({
      citizenId, actor, reason: input.reason, idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
    if (!result.ok) refuse(result);
    return { delivery: result.delivery, detail: result.detail };
  }

  @Post(':citizenId/rectification')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:administer')
  async rectification(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(rectifyShape, body);
    const result = await this.citizens.rectify({
      citizenId, actor, reason: input.reason, idempotencyKey: idempotencyKeyOf(idempotencyKey),
      changes: input.changes,
    });
    if (!result.ok) refuse(result);
    return { rectified: true, mobileVerificationCleared: result.mobileVerificationCleared };
  }

  @Post(':citizenId/erasure')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('staff:administer')
  async erasure(
    @Req() request: AuthenticatedRequest,
    @Param('citizenId') citizenId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = actorOf(request);
    const input = parse(eraseShape, body);
    const result = await this.citizens.erase({
      citizenId, actor, reason: input.reason, requestReference: input.requestReference,
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
    if (!result.ok) refuse(result);
    const { acceptedAt, erasedCategories, retainedCategories } = result.receipt;
    return { acceptedAt, erasedCategories, retainedCategories };
  }
}
