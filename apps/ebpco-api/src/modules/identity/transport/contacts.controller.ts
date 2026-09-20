import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { StructuredLogger } from '../../../common/logging/logger';
import { RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import { Channel, ContactVerificationService } from '../application/contact-verification.service';
import { ContactVerificationMailer } from '../application/contact-verification-mailer';

/**
 * The applicant proving the LGU can reach them.
 *
 * ── The code never crosses this boundary ────────────────────────────────
 *
 * `request` returns the code to its caller so a delivery adapter can send it.
 * This controller DISCARDS it from the RESPONSE. Returning it there would
 * make the whole exercise a formality: an applicant who can read the code in
 * the reply has proved only that they can read their own screen, which is
 * precisely the fabrication the mobile client refused to perform from the
 * other side. It is still used, once, to actually send the email below.
 *
 * ── Email vs mobile ──────────────────────────────────────────────────────
 *
 * `email` sends for real once `ContactVerificationMailer` is bound to a real
 * driver (`MAIL_DRIVER=smtp`) — see that class and `mailer-factory.ts`.
 * `mobile` still has no SMS provider (M-27): that channel's own request
 * still answers honestly that nothing was sent, same as this whole endpoint
 * did before a mail driver existed at all.
 */

const confirmShape = z.object({
  // Six digits. Bounded here so a megabyte of "code" never reaches a hash.
  code: z.string().regex(/^\d{6}$/, 'must be the six-digit code'),
}).strict();

function channelOf(raw: string): Channel {
  if (raw !== 'email' && raw !== 'mobile') {
    throw ProblemException.notFound(
      `There is no "${raw}" contact channel. The two are: email, mobile.`,
    );
  }
  return raw;
}

function accountOf(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}

@Controller('me/contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactVerificationService,
    private readonly mailer: ContactVerificationMailer,
    private readonly logger: StructuredLogger,
  ) {}

  @Get()
  @RequireScopes('profile:read')
  async list(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return { data: await this.contacts.statesFor(accountOf(request)) };
  }

  @Post(':channel/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('profile:write')
  async request(
    @Req() request: AuthenticatedRequest, @Param('channel') channel: string,
  ): Promise<Record<string, unknown>> {
    const resolvedChannel = channelOf(channel);
    const result = await this.contacts.request({
      accountId: accountOf(request), channel: resolvedChannel,
    });
    if (!result.ok) return refuse(result);

    // `mobile` has no SMS provider yet (M-27) — same honest "recorded, not
    // delivered" answer this whole endpoint gave before a mail driver
    // existed at all. `email` sends for real once `this.mailer.real` is
    // true (MAIL_DRIVER=smtp) — awaited, not fire-and-forget: unlike
    // password/forgot (public, anti-enumeration), this route is
    // authenticated and scoped to the caller's own account, so there is no
    // timing oracle to protect and an applicant benefits from knowing NOW
    // whether the code actually went out.
    if (resolvedChannel === 'email' && this.mailer.real) {
      try {
        await this.mailer.sendCode(result.state.value, result.code);
      } catch (cause) {
        this.logger.error('contact-verification email could not be sent', {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        return {
          ...result.state,
          delivery: 'failed',
          detail: 'The code was generated, but the email could not be sent just now. '
            + 'Try again in a moment, or ask the office to verify this channel for you.',
        };
      }
      return {
        ...result.state,
        delivery: 'sent',
        detail: 'A 6-digit code was sent to this email address. It expires in a few minutes.',
      };
    }

    return {
      ...result.state,
      // 202, and this, because the honest answer is "recorded, not delivered".
      // An applicant told to check their messages when nothing was sent is
      // being asked to wait for something that is not coming.
      delivery: 'not-sent',
      detail: resolvedChannel === 'email'
        ? 'The request is recorded. The LGU has no message provider configured yet, '
          + 'so no code has been sent — ask the office to verify this channel for you.'
        : 'The request is recorded. The LGU cannot send SMS yet, '
          + 'so no code has been sent — ask the office to verify this channel for you.',
    };
  }

  @Post(':channel/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('profile:write')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('channel') channel: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = confirmShape.safeParse(body);
    if (!parsed.success) {
      throw ProblemException.validation(
        parsed.error.issues.map((issue) => ({
          pointer: `/${issue.path.join('/')}`, message: issue.message,
        })),
      );
    }
    const result = await this.contacts.confirm({
      accountId: accountOf(request), channel: channelOf(channel), code: parsed.data.code,
    });
    if (!result.ok) return refuse(result);
    return { ...result.state };
  }
}

function refuse(result: { reason: string; detail: string }): never {
  if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
  // Everything else is a state the channel is in, not a missing thing and not
  // an authorisation failure: already verified, nothing outstanding, expired,
  // wrong code, asked too soon.
  throw new ProblemException(
    ProblemType.conflict, 'The channel is not in a state that permits this',
    HttpStatus.CONFLICT, result.detail,
  );
}
