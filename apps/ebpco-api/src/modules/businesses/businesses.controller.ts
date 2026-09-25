import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../common/problem/problem';
import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { RequireScopes } from '../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../identity/transport/guards/authentication.guard';
import { IN_PROGRESS_STATUSES } from './in-progress-statuses';
import { CASTILLA_BARANGAYS } from './castilla-barangays';

/**
 * The businesses an applicant has registered with the LGU.
 *
 * A thin surface over two queries, deliberately without a service. There is no
 * rule here beyond "yours, and validly shaped" — inventing a service whose only
 * method wraps an INSERT adds a layer without adding a decision, and the layer
 * would then be the place someone puts the rule that should have been a
 * constraint.
 */

/**
 * `.strict()` throughout.
 *
 * Zod strips unknown keys by default, so an `ownerApplicantId` in the body
 * would be silently ignored. That is safe — the owner comes from the token —
 * and it is not honest: a client sending it has been given no reason to think
 * it was not honoured, and would believe it had registered a business in
 * someone else's name.
 */
const businessShape = z.object({
  name: z.string().min(1).max(200),
  category: z.enum([
    'Retail', 'Food Service', 'Services', 'Manufacturing',
    'Construction', 'Transport', 'Agriculture', 'Other',
  ]),
  street: z.string().min(1).max(200),
  barangay: z.enum(CASTILLA_BARANGAYS),
  city: z.string().min(1).max(120),
  province: z.string().min(1).max(120),
  registrationNumber: z.string().min(1).max(80),
  dateRegistered: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
}).strict();

/**
 * What an owner may correct about a business already on file.
 *
 * Deliberately a SUBSET of `businessShape`, not `businessShape.partial()`:
 * `registrationNumber` and `dateRegistered` are the government's own record
 * of when and under what number this business was registered, not the
 * owner's to rewrite, and `status` is not a free-text field here at all —
 * see `deactivate`/`reactivate` below for why that is its own action rather
 * than a value this endpoint accepts.
 */
const businessUpdateShape = z.object({
  name: z.string().min(1).max(200),
  category: z.enum([
    'Retail', 'Food Service', 'Services', 'Manufacturing',
    'Construction', 'Transport', 'Agriculture', 'Other',
  ]),
  street: z.string().min(1).max(200),
  barangay: z.enum(CASTILLA_BARANGAYS),
  city: z.string().min(1).max(120),
  province: z.string().min(1).max(120),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

const SELECT = `
  select b.id, b.name, b.category, b.street, b.barangay, b.city, b.province,
         b.registration_number, to_char(b.date_registered, 'YYYY-MM-DD') as date_registered, b.status
    from businesses b
    join applicants ap on ap.id = b.owner_applicant_id
`;

function onTheWire(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    street: row.street,
    barangay: row.barangay,
    city: row.city,
    province: row.province,
    registrationNumber: row.registration_number,
    dateRegistered: row.date_registered,
    status: row.status,
  };
}

@Controller('businesses')
export class BusinessesController {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  @Get()
  @RequireScopes('profile:read')
  async list(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const accountId = accountOf(request);
    const result = await this.db.query<Record<string, never>>(
      `${SELECT} where ap.account_id = $1 order by b.name`,
      [accountId],
    );
    return { data: (result.rows as unknown as Record<string, unknown>[]).map(onTheWire) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('profile:write')
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const accountId = accountOf(request);
    const input = parse(businessShape, body);

    const applicant = await this.db.query<{ id: string }>(
      'select id from applicants where account_id = $1', [accountId],
    );
    const applicantId = applicant.rows[0]?.id;
    if (applicantId === undefined) {
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
        'This account has no applicant profile. Complete your profile before registering a business.',
      );
    }

    // The owner comes from the token, never from the body. A `ownerApplicantId`
    // field would be an endpoint for registering a business in someone else's
    // name.
    const inserted = await this.db.query<Record<string, never>>(
      `insert into businesses (owner_applicant_id, name, category, street, barangay, city,
                               province, registration_number, date_registered)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, name, category, street, barangay, city, province,
                 registration_number, to_char(date_registered, 'YYYY-MM-DD') as date_registered, status`,
      [
        applicantId, input.name, input.category, input.street, input.barangay,
        input.city, input.province, input.registrationNumber, input.dateRegistered,
      ],
    );

    return onTheWire((inserted.rows as unknown as Record<string, unknown>[])[0] ?? {});
  }

  /**
   * Correcting a business's own details — never who owns it, never its
   * government-assigned registration facts. 404, not 403, for a business
   * that exists but belongs to someone else: same reasoning as every other
   * owned-resource lookup in this API (see `documents`' own contentUrl) —
   * confirming it exists at all is itself a disclosure.
   */
  @Patch(':businessId')
  @RequireScopes('profile:write')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const accountId = accountOf(request);
    const input = parse(businessUpdateShape, body);

    const owned = await this.db.query<{ id: string }>(
      `select b.id from businesses b
         join applicants ap on ap.id = b.owner_applicant_id
        where b.id = $1 and ap.account_id = $2`,
      [businessId, accountId],
    );
    if (owned.rows[0] === undefined) throw ProblemException.notFound('No such business.');

    const updated = await this.db.query<Record<string, never>>(
      `update businesses
          set name = $2, category = $3, street = $4, barangay = $5, city = $6, province = $7,
              updated_at = now()
        where id = $1
        returning id, name, category, street, barangay, city, province,
                  registration_number, to_char(date_registered, 'YYYY-MM-DD') as date_registered, status`,
      [businessId, input.name, input.category, input.street, input.barangay, input.city, input.province],
    );

    return onTheWire((updated.rows as unknown as Record<string, unknown>[])[0] ?? {});
  }

  /**
   * Marks a business Inactive rather than deleting the row.
   *
   * `applications.business_id` is `on delete restrict` (migration 003) — a
   * business with ANY application ever filed against it, in any state, can
   * never be hard-deleted at all; Postgres refuses. `status` has existed on
   * this table since that same migration for exactly this reason and had
   * never been written by anything until now. Refused while an application
   * against this business is still in progress (mirrors decision E-4's own
   * boundary for cancelling an application): deactivating a business the
   * LGU is actively processing paperwork for is confusing to both sides,
   * and the applicant can always deactivate once that application reaches
   * a terminal state, or withdraw it first.
   */
  @Post(':businessId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('profile:write')
  async deactivate(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
  ): Promise<Record<string, unknown>> {
    return this.setStatus(request, businessId, 'Inactive');
  }

  /** The reverse of `deactivate` — a business the owner marked Inactive by mistake, or has resumed operating, is not stuck that way. */
  @Post(':businessId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('profile:write')
  async reactivate(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
  ): Promise<Record<string, unknown>> {
    return this.setStatus(request, businessId, 'Active');
  }

  private async setStatus(
    request: AuthenticatedRequest, businessId: string, status: 'Active' | 'Inactive',
  ): Promise<Record<string, unknown>> {
    const accountId = accountOf(request);

    const owned = await this.db.query<{ id: string }>(
      `select b.id from businesses b
         join applicants ap on ap.id = b.owner_applicant_id
        where b.id = $1 and ap.account_id = $2`,
      [businessId, accountId],
    );
    if (owned.rows[0] === undefined) throw ProblemException.notFound('No such business.');

    if (status === 'Inactive') {
      const inProgress = await this.db.query<{ id: string }>(
        `select id from applications where business_id = $1 and lifecycle_status = any($2)`,
        [businessId, IN_PROGRESS_STATUSES],
      );
      if (inProgress.rows[0] !== undefined) {
        throw new ProblemException(
          ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
          'This business has an application still in progress. Deactivate once it is decided, or withdraw it first.',
        );
      }
    }

    const updated = await this.db.query<Record<string, never>>(
      `update businesses
          set status = $2, updated_at = now()
        where id = $1
        returning id, name, category, street, barangay, city, province,
                  registration_number, to_char(date_registered, 'YYYY-MM-DD') as date_registered, status`,
      [businessId, status],
    );

    return onTheWire((updated.rows as unknown as Record<string, unknown>[])[0] ?? {});
  }
}

function accountOf(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}
