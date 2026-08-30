import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../../../common/problem/problem';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { StaffNotificationService } from '../application/staff-notification.service';

/**
 * TAB 14 — the officer's worklist.
 *
 * NO SCOPE BEYOND BEING STAFF, and that is a deliberate exception worth the
 * paragraph.
 *
 * The first version required `applications:read`, which reads sensibly and is
 * wrong: `administrator` holds ONLY `staff:administer`, so an administrator
 * could be sent a notice and then refused permission to read it. No scope is
 * held by every staff role -- that is what least privilege means here -- so no
 * `RequireScopes` can express "any officer, reading their own inbox".
 *
 * Deny-by-default is not weakened by this. The global guard still refuses an
 * unauthenticated caller and refuses any non-staff caller on a `/staff/` path,
 * and every statement below is scoped to the calling account in SQL. There is
 * nothing here an officer is not already being told.
 *
 * Every route here is scoped to the calling account in the SQL, not filtered
 * after the fact. An inbox is the one place where "whose is this" is the whole
 * question, and a row filter applied in the handler is one refactor away from
 * being applied to the wrong list.
 */
@Controller('staff/notifications')
export class StaffNotificationsController {
  constructor(private readonly notices: StaffNotificationService) {}

  @Get()
  async inbox(
    @Req() request: AuthenticatedRequest, @Query('limit') limit?: string,
  ): Promise<Record<string, unknown>> {
    const caller = this.staffCaller(request);
    const parsed = z.coerce.number().int().min(1).max(100).default(50).safeParse(limit ?? 50);
    if (!parsed.success) {
      throw ProblemException.validation([{ pointer: '/limit', message: 'must be 1 to 100' }]);
    }

    return {
      notifications: await this.notices.inboxFor(caller, parsed.data),
      // Unread, not unresolved. A staff notice is discharged by moving the
      // application, which the lifecycle already records -- a `resolved` count
      // here would be a second copy of a fact the transition table owns.
      unread: await this.notices.unreadCount(caller),
    };
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @Req() request: AuthenticatedRequest, @Param('notificationId') notificationId: string,
  ): Promise<void> {
    const caller = this.staffCaller(request);
    const parsed = z.string().uuid().safeParse(notificationId);
    if (!parsed.success) throw ProblemException.notFound('No such notification.');

    // 404 rather than 403 for someone else's notice. Answering "forbidden"
    // would confirm the notification exists, which is a fact about another
    // officer's queue.
    if (!await this.notices.markRead(caller, parsed.data, new Date())) {
      throw ProblemException.notFound('No such notification.');
    }
  }

  private staffCaller(request: AuthenticatedRequest): string {
    const claims = request.caller;
    if (claims === undefined || claims.kind !== 'staff') {
      // Unreachable through the guard, which already refuses a non-staff caller
      // on any /staff path. Kept because this handler reads an inbox by account
      // id, and a caller of the wrong kind here would read the wrong one.
      throw ProblemException.notFound('No such notification.');
    }
    return claims.sub;
  }
}
