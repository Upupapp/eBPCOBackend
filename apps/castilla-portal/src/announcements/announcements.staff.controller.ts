import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../http/problem';
import { AuthenticatedRequest, RequireScopes } from '../identity/auth.guard';
import { AnnouncementsService } from './announcements.service';

const draftSchema = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
  category: z.string().min(1).max(60),
  attachmentFormId: z.string().uuid().optional(),
}).strict();

const publishSchema = z.object({
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();

const withdrawSchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.badRequest(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

/** TAB 07's lifecycle, now with the identity TAB 11 supplies. */
@Controller('staff/announcements')
export class AnnouncementsStaffController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @RequireScopes('announcements:publish')
  @HttpCode(201)
  async draft(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const input = parse(draftSchema, body);
    // `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
    // undefined, and the domain means the first. Spreading conditionally rather
    // than widening the domain type keeps that distinction where it belongs.
    const result = await this.announcements.draft({
      slug: input.slug, title: input.title, body: input.body, category: input.category,
      ...(input.attachmentFormId === undefined
        ? {} : { attachmentFormId: input.attachmentFormId }),
    }, request.principal!.email);
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { id: result.id };
  }

  @Post(':slug/publish')
  @RequireScopes('announcements:publish')
  @HttpCode(200)
  async publish(
    @Param('slug') slug: string, @Body() body: unknown, @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const input = parse(publishSchema, body ?? {});
    const result = await this.announcements.publish(
      slug, request.principal!.email,
      input.publishAt === undefined ? new Date() : new Date(input.publishAt),
      input.expiresAt === undefined ? undefined : new Date(input.expiresAt));
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { published: true };
  }

  @Delete(':slug')
  @RequireScopes('announcements:publish')
  @HttpCode(200)
  async withdraw(
    @Param('slug') slug: string, @Body() body: unknown, @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const input = parse(withdrawSchema, body ?? {});
    const result = await this.announcements.withdraw(
      slug, request.principal!.email, input.reason);
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { withdrawn: true };
  }
}
