import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import { AuditService } from '../application/audit.service';
import {
  ACCESS_ACTIONS, SECURITY_STREAM_ACTIONS,
} from '../domain/security-events';

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
 * security and system events. **D-6 was answered on 2026-08-29: this serves
 * THREE of them, and deliberately not the other two.**
 *
 * Activity, access and security are records of WHO DID WHAT -- a sign-in, a
 * refused sign-in, a replayed refresh token, malware in an upload. They belong
 * in this table, which already hash-links them, retains them on the audit
 * schedule, and classifies every column in the privacy register. `?stream=`
 * selects one, so the client does not have to know which action names belong to
 * which tab.
 *
 * Error and system-event logs stay in the host's log stack. They are telemetry,
 * they are request-scale rather than act-scale, and -- the argument that
 * settles it -- an error log inside the database is unwritable exactly when the
 * database is the thing that has failed.
 */

const SUBJECT_TYPES = [
  'application', 'document', 'payment', 'order-of-payment', 'account', 'export',
] as const;

/**
 * The named streams. `activity` is everything that is not access or security,
 * which is how the first tab keeps meaning "the acts of the office" now that
 * sign-ins share the table with them.
 */
const STREAMS = ['activity', 'access', 'security'] as const;

const streamShape = z.object({
  stream: z.enum(STREAMS).optional(),
  action: z.string().min(1).max(80).optional(),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  actorAccountId: z.string().uuid().optional(),
  from: z.string().datetime({ message: 'must be an RFC 3339 timestamp' }).optional(),
  to: z.string().datetime({ message: 'must be an RFC 3339 timestamp' }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

/**
 * Activity is defined by SUBTRACTION, not by a list.
 *
 * A list would mean every new audited act had to be added here to appear
 * anywhere, and the failure mode of forgetting is an act that is recorded and
 * invisible -- which is worse than an act that is not recorded at all, because
 * the table says it was covered.
 */
function actionsFor(stream: (typeof STREAMS)[number]):
  { actions: readonly string[] } | { excludeActions: readonly string[] } {
  if (stream === 'access') return { actions: ACCESS_ACTIONS };
  if (stream === 'security') return { actions: SECURITY_STREAM_ACTIONS };
  return {
    excludeActions: [...new Set([...ACCESS_ACTIONS, ...SECURITY_STREAM_ACTIONS])],
  };
}

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
      ...(input.stream === undefined ? {} : actionsFor(input.stream)),
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
