import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../../../common/problem/problem';
import { SQL_CLIENT } from '../../../persistence/persistence.module';
import { SqlClient } from '../../../persistence/sql-client';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import { CALENDAR_REPOSITORY, CalendarRepository } from '../application/calendar.repository';
import { complianceReport } from '../application/compliance-report';

/**
 * How the LGU is doing against its own Citizen's Charter.
 *
 * The report was written, tested and reachable by nothing. Unlike `supersede` —
 * the other "already built" item this programme routed — it needed no rework
 * before exposure: it takes no figures from its caller, only a date range, and
 * computes everything from records. The difference is worth naming, because
 * "already built" was wrong about `supersede` and right about this. The check
 * is whether the thing trusts its caller for anything that matters.
 *
 * `applications:read`, not `staff:administer`. This is aggregate performance
 * information about the LGU itself, of the kind RA 11032 obliges it to publish;
 * there is nothing here about any applicant, and an officer measured by it has
 * a fair claim to see it.
 */

const rangeShape = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
}).strict().refine((value) => value.from < value.to, {
  message: 'from must be before to',
  path: ['from'],
});

@Controller('staff/reports')
export class ReportsController {
  constructor(
    @Inject(SQL_CLIENT) private readonly db: SqlClient,
    @Inject(CALENDAR_REPOSITORY) private readonly calendars: CalendarRepository,
  ) {}

  @Get('processing-times')
  @RequireScopes('applications:read')
  async processingTimes(@Query() query: unknown): Promise<Record<string, unknown>> {
    const parsed = rangeShape.safeParse(query ?? {});
    if (!parsed.success) {
      throw ProblemException.validation(
        parsed.error.issues.map((issue) => ({
          pointer: `/${issue.path.join('/')}`, message: issue.message,
        })),
      );
    }

    // The range is required rather than defaulted. A compliance figure with no
    // stated period is a number nobody can check, and "this year so far" means
    // something different every day it is read.
    const report = await complianceReport(this.db, {
      from: parsed.data.from,
      to: parsed.data.to,
      calendar: await this.calendars.load(),
      now: new Date(),
    });
    return { ...report };
  }
}
