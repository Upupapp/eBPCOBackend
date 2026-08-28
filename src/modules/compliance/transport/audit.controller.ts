import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import { AuditService } from '../application/audit.service';

/**
 * The audit trail, read.
 *
 * ── `audit:read`, which TAB 00 added and nothing used ───────────────────
 *
 * The scope was created for the Auditor role — read everything, change nothing —
 * and until now no route required it, which made the role a name without a
 * screen. `auditor` and `super-admin` hold it; no other role does, including
 * the officers whose acts are recorded here. An officer who could read the
 * whole trail could also see who has been looking at what.
 *
 * ── Metadata only ───────────────────────────────────────────────────────
 *
 * Neither route returns `before_state` or `after_state`. Those carry whatever
 * the act changed — an application edit's holds a street address, a role change
 * holds an officer's permissions — and the point of an audit trail is that it
 * can be read by someone not entitled to everything it records. Investigating
 * one entry means opening the subject it names, where the existing
 * authorisation applies.
 *
 * ── What is NOT here, and why ───────────────────────────────────────────
 *
 * The portal's System Logs screen has five streams: activity, access, error,
 * security and system events. This serves the FIRST. The other four are
 * operational telemetry — request logs, stack traces, authentication failures —
 * and they are not this table. Serving them from here would mean either
 * diluting a hash-linked evidential chain with log lines, or making the API a
 * log store. Which of those the LGU wants, or whether that screen should point
 * at whatever hosts the logs, is decision D-6 and not one to take by writing a
 * route.
 */

const SUBJECT_TYPES = [
  'application', 'document', 'payment', 'order-of-payment', 'account', 'export',
] as const;

const streamShape = z.object({
  action: z.string().min(1).max(80).optional(),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  actorAccountId: z.string().uuid().optional(),
  from: z.string().datetime({ message: 'must be an RFC 3339 timestamp' }).optional(),
  to: z.string().datetime({ message: 'must be an RFC 3339 timestamp' }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`, message: issue.message,
      })),
    );
  }
  return result.data;
}

@Controller('staff/audit')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequireScopes('audit:read')
  async stream(@Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(streamShape, query ?? {});
    const page = await this.audit.stream({
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.subjectType === undefined ? {} : { subjectType: input.subjectType }),
      ...(input.actorAccountId === undefined ? {} : { actorAccountId: input.actorAccountId }),
      ...(input.from === undefined ? {} : { from: new Date(input.from) }),
      ...(input.to === undefined ? {} : { to: new Date(input.to) }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.before === undefined ? {} : { before: input.before }),
    });
    return { entries: page.entries, nextCursor: page.nextCursor };
  }

  @Get(':subjectType/:subjectId')
  @RequireScopes('audit:read')
  async history(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ): Promise<Record<string, unknown>> {
    if (!(SUBJECT_TYPES as readonly string[]).includes(subjectType)) {
      // Named rather than returning an empty list. "No entries" and "there is no
      // such kind of thing" are different answers, and an auditor told the first
      // when the second is true stops looking.
      throw ProblemException.notFound(
        `There is no "${subjectType}" subject. The kinds recorded are: ${SUBJECT_TYPES.join(', ')}.`,
      );
    }
    return { subjectType, subjectId, entries: await this.audit.historyOf(subjectType, subjectId) };
  }
}
