import { Body, Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../http/problem';
import { AuthenticatedRequest, RequireScopes } from './auth.guard';
import { IdentityService } from './identity.service';

const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(4096),
}).strict();

@Controller('session')
export class SessionController {
  constructor(private readonly identity: IdentityService) {}

  @Post()
  @HttpCode(200)
  async signIn(@Body() body: unknown): Promise<unknown> {
    const parsed = credentialsSchema.safeParse(body);
    // Even a malformed body gets the generic refusal. Telling a caller their
    // email was well-formed but the password wrong is the same oracle by
    // another route.
    if (!parsed.success) throw ProblemException.unauthorised();

    const result = await this.identity.signIn(parsed.data.email, parsed.data.password);
    if (!result.ok) throw ProblemException.unauthorised();

    return {
      token: result.token,
      account: {
        email: result.principal.email,
        displayName: result.principal.displayName,
        role: result.principal.role,
        scopes: result.principal.scopes,
      },
    };
  }

  @Get()
  @RequireScopes('content:read')
  who(@Req() request: AuthenticatedRequest): unknown {
    const principal = request.principal!;
    return {
      email: principal.email, displayName: principal.displayName,
      role: principal.role, scopes: principal.scopes,
    };
  }

  @Delete()
  @RequireScopes('content:read')
  @HttpCode(204)
  async signOut(@Req() request: AuthenticatedRequest): Promise<void> {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      await this.identity.signOut(header.slice('Bearer '.length));
    }
  }
}
