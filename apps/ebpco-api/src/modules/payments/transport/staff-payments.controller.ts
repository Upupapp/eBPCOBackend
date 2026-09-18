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
import { LifecycleService } from '../../applications/application/lifecycle.service';
import { StructuredLogger } from '../../../common/logging/logger';

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

const undoShape = z.object({
  reason: z.string().min(10, 'state a reason an applicant can be told').max(2000),
}).strict();

const receiptShape = z.object({
  officialReceiptNumber: z.string().min(1).max(60),
  reason: z.string().min(10, 'state why the number is being corrected').max(2000),
}).strict();

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
    // From LifecycleModule (@Global()), not an import of ApplicationsModule —
    // that module already imports this one (PaymentsModule), so the reverse
    // import would be circular. See lifecycle.module.ts's own doc comment.
    private readonly lifecycle: LifecycleService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * The payments queue, optionally narrowed to one status.
   *
   * Returns every status by default. A payment recorded Onsite is inserted
   * already 'Paid' (the cashier witnessed the cash in person, so there is
   * nothing left to verify) and never passes through 'Pending Verification'
   * at all — a default that silently filtered to that one status made such a
   * payment look missing rather than merely elsewhere. Pass `status` to get
   * the cashier's narrower worklist or an archive view.
   */
  @Get()
  @RequireScopes('staff:verify-payment')
  async queue(@Query() query: unknown): Promise<Record<string, unknown>> {
    const input = parse(queueShape, query ?? {});
    const status = input.status ?? null;
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
        where $1::text is null or p.status = $1
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
    const officer = callerOf(request);
    const result = await this.payments.verify({
      paymentId, officer, officialReceiptNumber: input.officialReceiptNumber,
    });

    if (result.ok) {
      // The move this route exists to cause, same gap and same reasoning as
      // `StaffActionsController.recordOnsite`'s own follow-on: confirming a
      // payment only ever wrote the `payments` row, so a verified payment
      // left the application sitting at `Payment Submitted` (or earlier)
      // forever — no queue, board or timeline ever showed it moving, even
      // though the money was confirmed. Both remaining hops are staff-actor
      // moves, so `officer` (not a synthetic caller) drives both.
      //
      // Best-effort and logged, not thrown: the payment above is already
      // committed, so a refused status move must not turn a real
      // verification into an error response the cashier reads as "that
      // failed." Logged specifically because the silent version of this
      // exact pattern (recordOnsite/pay's own follow-ons) took real
      // diagnostic effort to notice was ever failing at all — nothing about
      // a swallowed refusal was visible anywhere until the data was read back
      // by hand.
      const underVerification = await this.lifecycle.transition({
        applicationId: result.applicationId, caller: officer, to: 'Payment Under Verification',
      });
      if (underVerification.ok) {
        const verified = await this.lifecycle.transition({
          applicationId: result.applicationId, caller: officer, to: 'Payment Verified',
        });
        if (!verified.ok) {
          this.logger.warn('payment verified but the application did not advance to Payment Verified', {
            applicationId: result.applicationId, paymentId: result.paymentId,
            refusal: 'refusal' in verified ? verified.refusal : { kind: 'reused' },
          });
        }
      } else {
        this.logger.warn('payment verified but the application did not advance to Payment Under Verification', {
          applicationId: result.applicationId, paymentId: result.paymentId,
          refusal: 'refusal' in underVerification ? underVerification.refusal : { kind: 'reused' },
        });
      }
      return { paymentId: result.paymentId, verified: true };
    }

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

  /**
   * The three ways a payment is undone, and one correction.
   *
   * Separate routes rather than one carrying a `kind`, because they are not
   * variations of one act: a void says the record was a mistake, a reversal
   * says the money never came, a refund says it came and is going back. A
   * client that could get the enum wrong would be asserting the opposite of
   * what it meant about who is out of pocket.
   */
  @Post(':paymentId/void')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async void(
    @Req() request: AuthenticatedRequest, @Param('paymentId') paymentId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.undo(request, paymentId, body, 'Voided');
  }

  @Post(':paymentId/reverse')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async reverse(
    @Req() request: AuthenticatedRequest, @Param('paymentId') paymentId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.undo(request, paymentId, body, 'Reversed');
  }

  @Post(':paymentId/refund')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async refund(
    @Req() request: AuthenticatedRequest, @Param('paymentId') paymentId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.undo(request, paymentId, body, 'Refunded');
  }

  private async undo(
    request: AuthenticatedRequest, paymentId: string, body: unknown,
    kind: 'Voided' | 'Reversed' | 'Refunded',
  ): Promise<Record<string, unknown>> {
    const input = parse(undoShape, body);
    const result = await this.payments.undo({
      paymentId, kind, officer: callerOf(request), reason: input.reason,
    });
    if (result.ok) return { paymentId: result.paymentId, status: kind };
    if (result.reason === 'not-found') throw ProblemException.notFound(result.detail);
    if (result.reason === 'not-permitted') {
      throw new ProblemException(
        ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
      );
    }
    throw new ProblemException(
      ProblemType.conflict, 'The resource is not in a state that permits this',
      HttpStatus.CONFLICT, result.detail,
    );
  }

  @Post(':paymentId/receipt')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:verify-payment')
  async receipt(
    @Req() request: AuthenticatedRequest, @Param('paymentId') paymentId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(receiptShape, body);
    const result = await this.payments.correctReceipt({
      paymentId, officer: callerOf(request),
      officialReceiptNumber: input.officialReceiptNumber, reason: input.reason,
    });
    if (result.ok) return { paymentId: result.paymentId, officialReceiptNumber: input.officialReceiptNumber };
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
