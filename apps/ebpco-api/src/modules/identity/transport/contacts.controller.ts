import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import { Channel, ContactVerificationService } from '../application/contact-verification.service';

/**
 * The applicant proving the LGU can reach them.
 *
 * ── The code never crosses this boundary ────────────────────────────────
 *
 * `request` returns the code to its caller so a delivery adapter can send it.
 * This controller DISCARDS it. Returning it in the response would make the
 * whole exercise a formality: an applicant who can read the code in the reply
 * has proved only that they can read their own screen, which is precisely the
 * fabrication the mobile client refused to perform from the other side.
 *
 * Nothing sends it either — there is no email or SMS provider (E-1, M-27), so
 * the queued notice goes nowhere. The refusals below are all real; the success
 * path cannot be reached by a human until a provider exists. Said in the
 * response rather than left for someone to discover.
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
  constructor(private readonly contacts: ContactVerificationService) {}

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
    const result = await this.contacts.request({
      accountId: accountOf(request), channel: channelOf(channel),
    });
    if (!result.ok) return refuse(result);

    return {
      ...result.state,
      // 202, and this, because the honest answer is "recorded, not delivered".
      // An applicant told to check their messages when nothing was sent is
      // being asked to wait for something that is not coming.
      delivery: 'not-sent',
      detail: 'The request is recorded. The LGU has no message provider configured yet, '
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
