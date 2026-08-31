import { Body, Controller, HttpCode, Param, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../http/problem';
import { AuthenticatedRequest, RequireScopes } from '../identity/auth.guard';
import { PagesService } from './pages.service';

const editSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(50000),
  isPlaceholder: z.boolean(),
}).strict();

/** TAB 09's page editing, now with the identity TAB 11 supplies. */
@Controller('staff/pages')
export class PagesStaffController {
  constructor(private readonly pages: PagesService) {}

  @Put(':key')
  @RequireScopes('pages:edit')
  @HttpCode(200)
  async replace(
    @Param('key') key: string, @Body() body: unknown, @Req() request: AuthenticatedRequest,
  ): Promise<{ replaced: true }> {
    const parsed = editSchema.safeParse(body);
    if (!parsed.success) {
      throw ProblemException.badRequest(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const result = await this.pages.replace(key, parsed.data, request.principal!.email);
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { replaced: true };
  }
}
