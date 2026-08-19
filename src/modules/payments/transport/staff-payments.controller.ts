import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { SQL_CLIENT } from '../../../persistence/persistence.module';
import { SqlClient } from '../../../persistence/sql-client';
import { exactInteger } from '../../../persistence/numeric-parsing';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../../applications/domain/application';
import { PaymentService } from '../application/payment.service';

/**
 * The cashier's queue, and the two decisions made from it.
 *
 * A payment is verified against an Official Receipt number, and rejected with a
 * reason the applicant can act on. Neither is a status the client may set: the
 * service holds the separation-of-duty rule that the officer who recorded a
 * payment may not confirm it, and a client-side status update would route
 * around it.
 */

const verifyShape = z.object({
  officialReceiptNumber: z.string().min(1).max(60),
});

const rejectShape = z.object({
  reason: z.string().min(10, 'state a reason the applicant can act on').max(2000),
});

const queueShape = z.object({
  status: z.enum(['Pending Verification', 'Paid', 'Not Yet Available', 'Overdue']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

function callerOf(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

const parseCentavos = exactInteger('amount');

@Controller('staff/payments')
export class StaffPaymentsController {
  constructor(
    private readonly payments: PaymentService,
    // Injected by token: SqlClient is an interface, and an interface cannot be
    // a runtime DI key. Used for the queue read only — see the module comment.
    @Inject(SQL_CLIENT) private readonly db: SqlClient,
  ) {}

  /**
   * What is waiting to be checked.
   *
   * Defaults to Pending Verification, because that is the queue: a cashier
   * opening this screen wants the work, not the archive. The reference number
   * and the amount come with it so a row can be matched against a bank
   * statement without opening each one.
   */
  @Get()
  @RequireScopes('staff:verify-payment')
  async queue(@Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(queueShape, query ?? {});
    const status = input.status ?? 'Pending Verification';
    const limit = input.limit ?? 50;

    const result = await this.db.query<{
      id: string; application_id: string; reference_number: string; application_reference: string;
      amount_centavos: string; method: string; status: string; submitted_at: Date;
      applicant_name: string; official_receipt_number: string | null;
    }>(
      `select p.id, p.application_id, p.reference_number, a.reference_number as application_reference,
              p.amount_centavos, p.method, p.status, p.submitted_at,
              ap.first_name || ' ' || ap.last_name as applicant_name, p.official_receipt_number
         from payments p
         join applications a on a.id = p.application_id
         join applicants ap on ap.id = a.applicant_id
        where p.status = $1
        order by p.submitted_at
        limit $2`,
      [status, limit],
    );

    return {
      items: result.rows.map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        applicationReference: row.application_reference,
        referenceNumber: row.reference_number,
        applicantName: row.applicant_name,
        amountCentavos: parseCentavos(String(row.amount_centavos)),
        method: row.method,
        status: row.status,
        submittedAt: new Date(row.submitted_at).toISOString(),
        officialReceiptNumber: row.official_receipt_number,
      })),
    };
  }

  @Post(':paymentId/verify')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async verify(
    @Req() request: AuthenticatedRequest,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(verifyShape, body);
    const result = await this.payments.verify({
      paymentId, officer: callerOf(request), officialReceiptNumber: input.officialReceiptNumber,
    });

    if (result.ok) return { paymentId: result.paymentId, verified: true };

    // Self-verification is 403 and not 409: the caller is not permitted, and
    // telling them the payment is in the wrong state would send them to fix
    // something that is not wrong.
    if (result.reason === 'self-verification') {
      throw new ProblemException(
        ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
      );
    }
    if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
    throw new ProblemException(
      ProblemType.conflict, 'The resource is not in a state that permits this',
      HttpStatus.CONFLICT, result.detail,
    );
  }

  @Post(':paymentId/reject')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async reject(
    @Req() request: AuthenticatedRequest,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    // The reason travels to the applicant verbatim. "Payment rejected" with no
    // explanation leaves them unable to fix it, and the money may genuinely
    // have left their account.
    const input = parse(rejectShape, body);
    const result = await this.payments.reject({
      paymentId, officer: callerOf(request), reason: input.reason,
    });

    if (result.ok) return { paymentId: result.paymentId, rejected: true };
    throw ProblemException.notFound(result.detail);
  }
}
