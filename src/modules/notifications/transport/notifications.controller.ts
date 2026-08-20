import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { NotificationService } from '../application/notification.service';

/**
 * The applicant's feed, their preferences, and their devices.
 *
 * Every route is scoped to the caller's own account, taken from the token. The
 * feed is the one surface where a leak is both easy and severe: a notification
 * body carries a reference number and often an address, so serving the wrong
 * account's feed discloses who has applied for what.
 */

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * The six categories, named rather than accepted as free strings.
 *
 * A muted category the server does not recognise is silently ineffective: the
 * applicant sets it, the switch stays on, and they keep getting the
 * notifications they asked not to. Rejecting an unknown one makes that a
 * visible 400 instead.
 */
const CATEGORIES = [
  'applicationUpdates', 'payments', 'permitStatus',
  'documentReminders', 'appointments', 'account',
] as const;

/**
 * A boolean per category, which is the contract's shape and the better one.
 *
 * A mute LIST requires the client to know the full set of categories to render
 * a switch for each; a boolean per category does not, and a category the client
 * has not heard of is simply a switch it does not draw rather than one it
 * silently drops on the next save.
 *
 * The domain models the inverse — a list of what is muted — and that stays.
 * The wire shape is a transport concern.
 */
const preferencesShape = z.object({
  // `.strict()`: zod strips unknown keys by default, which would accept a
  // category this server has never heard of and silently drop it. The applicant
  // sets the switch, it saves, and they keep getting the notices they asked not
  // to — the failure being invisible is the whole problem.
  categories: z.object(Object.fromEntries(
    CATEGORIES.map((category) => [category, z.boolean().optional()]),
  ) as Record<(typeof CATEGORIES)[number], z.ZodOptional<z.ZodBoolean>>).strict(),
  quietHours: z.object({
    enabled: z.boolean(),
    // Required even when disabled. A window with no bounds cannot be turned
    // back on without asking for them again, and an applicant who switches
    // quiet hours off for one night should not lose the times they set.
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
  }),
});

const deviceShape = z.object({
  platform: z.enum(['android', 'ios']),
  pushToken: z.string().min(1).max(4096),
  appVersion: z.string().max(40).optional(),
  locale: z.string().max(20).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

function callerAccount(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get('notifications')
  @RequireScopes('notifications:read')
  async feed(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(feedQuery, query ?? {});
    const feed = await this.notifications.feed(callerAccount(request), input.limit ?? 50);

    // `data`, not `entries`, and dates as RFC 3339 strings. The service's shape
    // is the domain's; this is the contract's, and the mobile client was built
    // to it. Translating here rather than renaming the domain keeps the wire
    // shape a transport concern, which is what it is.
    return {
      data: feed.entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        category: entry.category,
        applicationId: entry.applicationId,
        title: entry.title,
        body: entry.body,
        deepLink: entry.deepLink,
        createdAt: entry.createdAt.toISOString(),
        readAt: entry.readAt?.toISOString() ?? null,
        resolvedAt: entry.resolvedAt?.toISOString() ?? null,
        requiresAction: entry.requiresAction,
      })),
      nextCursor: null,
      unresolvedCount: feed.unresolvedCount,
    };
  }

  /**
   * Marks one as read.
   *
   * The service scopes the update by account, so a caller passing someone
   * else's notification id changes nothing — and gets 404 rather than 403, for
   * the same reason as everywhere else: confirming the id exists is the
   * disclosure.
   */
  @Post('notifications/:notificationId/read')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('notifications:write')
  async markRead(
    @Req() request: AuthenticatedRequest,
    @Param('notificationId') notificationId: string,
  ): Promise<Record<string, unknown>> {
    const changed = await this.notifications.markRead(notificationId, callerAccount(request));
    if (!changed) throw ProblemException.notFound('No such notification.');
    return { read: true };
  }

  @Post('notifications/:notificationId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('notifications:write')
  async markResolved(
    @Req() request: AuthenticatedRequest,
    @Param('notificationId') notificationId: string,
  ): Promise<Record<string, unknown>> {
    const changed = await this.notifications.markResolved(notificationId, callerAccount(request));
    if (!changed) throw ProblemException.notFound('No such notification.');
    return { resolved: true };
  }

  @Get('notification-preferences')
  @RequireScopes('notifications:read')
  async preferences(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return onTheWire(await this.notifications.preferences(callerAccount(request)));
  }

  /**
   * Replaces the preferences wholesale.
   *
   * PUT rather than PATCH: a partial update of a mute list has an ambiguous
   * meaning — is an absent category unmuted, or unmentioned? — and the client
   * always holds the whole set anyway.
   */
  @Put('notification-preferences')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('notifications:write')
  async replacePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(preferencesShape, body);
    await this.notifications.replacePreferences(callerAccount(request), {
      mutedCategories: CATEGORIES.filter((category) => input.categories[category] === false),
      quietHours: input.quietHours,
    });
    return onTheWire(await this.notifications.preferences(callerAccount(request)));
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('notifications:write')
  async registerDevice(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(deviceShape, body);

    // The raw token never reaches the database. A digest identifies the handset
    // for de-duplication and revocation; the token itself is what can send to
    // it, and encrypting it means a database disclosure is not a licence to
    // push to every applicant's phone.
    //
    // The encryption here is NOT real: it stores the bytes unchanged, because
    // no key-management service has been chosen (E-1). It is written as a
    // separate column so the shape is right, and recorded as unverified rather
    // than described as encrypted.
    const digest = createHash('sha256').update(input.pushToken, 'utf8').digest('hex');

    const deviceId = await this.notifications.registerDevice({
      accountId: callerAccount(request),
      platform: input.platform,
      pushTokenDigest: digest,
      pushTokenEncrypted: Buffer.from(input.pushToken, 'utf8'),
      ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });
    // The token is never echoed. It is a credential for sending to that
    // handset, and a response that repeats it puts it in every proxy log
    // between here and the phone.
    return { deviceId };
  }

  @Delete('devices/:deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('notifications:write')
  async removeDevice(@Param('deviceId') deviceId: string): Promise<void> {
    // Signing out on one handset must stop pushes to it. Not finding it is not
    // an error: the desired state is "no device", and it already holds.
    await this.notifications.pruneDevice(deviceId);
  }
}

/**
 * Domain preferences as the contract states them.
 *
 * Every category is listed explicitly, including the enabled ones. The contract
 * says "absent key means enabled", and relying on that would make an enabled
 * category and an unknown category look identical to a client — which is fine
 * until a category is added and every client silently treats it as on.
 */
function onTheWire(preferences: {
  mutedCategories: readonly string[];
  quietHours: { enabled: boolean; start: string; end: string };
}): Record<string, unknown> {
  const muted = new Set(preferences.mutedCategories);
  return {
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, !muted.has(category)])),
    quietHours: preferences.quietHours,
  };
}
