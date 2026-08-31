import { Controller, Get, Param } from '@nestjs/common';

import { RequireScopes } from '../identity/auth.guard';
import { AuditRepository, AuditRow } from './audit.repository';

/**
 * An entity's editorial history, for staff.
 *
 * `content:read` — the lowest staff scope, held by every role including
 * `viewer`. Reading the history is how an editor checks whether a fact is
 * already being handled, and gating it behind a write scope would push people
 * towards a database session, which is the thing this endpoint exists to avoid.
 */
@Controller('staff/history')
export class AuditController {
  constructor(private readonly audit: AuditRepository) {}

  @Get(':entityType/:entityId')
  @RequireScopes('content:read')
  async history(
    @Param('entityType') entityType: string, @Param('entityId') entityId: string,
  ): Promise<{ history: AuditRow[] }> {
    return { history: await this.audit.history(entityType, entityId) };
  }
}
