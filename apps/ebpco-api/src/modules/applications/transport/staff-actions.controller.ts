import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import { FollowOnResult, LifecycleService } from '../application/lifecycle.service';
import { StaffQueueService } from '../application/staff-queue.service';
import { EVALUATION_RESULTS, EVALUATION_STAGES, EvaluationService } from '../application/evaluation.service';
import { AssessmentService } from '../../payments/application/assessment.service';
import { PermitService } from '../../permits/application/permit.service';
import { PaymentService } from '../../payments/application/payment.service';
import { DocumentService } from '../../documents/application/document.service';
import { requestDigest } from '../../../persistence/idempotency';
import { StructuredLogger } from '../../../common/logging/logger';

/**
 * The things an officer DOES to an application, as opposed to reading it.
 *
 * Separate from the queue controller because these are the operations that
 * change the record, and every one of them is scope-gated by the specific duty
 * it belongs to: an evaluator cannot issue an Order of Payment, an assessor
 * cannot generate a permit. That separation is the point of the role table, and
 * putting reads and writes in one class makes it easy to widen a scope for a
 * read and quietly widen it for a write.
 *
 * Each route first asks the queue service whether this caller may see the
 * application at all. Not-yours and not-there answer alike, for the same reason
 * as everywhere else: telling an officer that a reference exists but is not
 * theirs confirms a neighbour has applied for a permit.
 */

const evaluationShape = z.object({
  stage: z.enum(EVALUATION_STAGES),
  result: z.enum(EVALUATION_RESULTS),
  remarks: z.string().max(4000).optional(),
});

const orderOfPaymentShape = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
});

const permitShape = z.object({
  scope: z.string().min(1).max(2000),
  conditions: z.array(z.string().max(1000)).max(50).optional(),
});

/**
 * Cash across a counter.
 *
 * No `method` field: this endpoint IS the onsite one, and letting a caller
 * choose would let a cashier record a bank transfer as though they had received
 * it in person. No `submittedBy` either — the submitter is the applicant, taken
 * from the application, because that is who paid.
 */
const onsiteShape = z.object({
  officialReceiptNumber: z.string().min(1).max(60),
  // Required, and must equal the Order of Payment exactly (ADR 0010). Defaulting
  // it to the assessed total would mean a mistyped receipt still recorded a
  // settled payment.
  amountCentavos: z.number().int().min(1),
}).strict();

const preparationShape = z.object({
  claimLocation: z.string().min(1).max(400),
  officeHours: z.string().min(1).max(200),
  bringWithYou: z.array(z.string().max(300)).max(20).optional(),
});

const releaseShape = z.object({
  claimantName: z.string().min(1).max(200),
  method: z.enum(['Physical Claim', 'Authorized Representative']),
});

const documentReviewShape = z.object({
  status: z.enum(['Under Review', 'Accepted', 'Rejected', 'Revision Required']),
  reasonCode: z.string().max(100).optional(),
  remark: z.string().max(4000).optional(),
});

/**
 * Same shape `POST /applications/:applicationId/documents/:documentId/resubmit`
 * (the applicant-only route) accepts — this is the same act, the walk-in
 * citizen just is not the one at the keyboard.
 */
const documentResubmitShape = z.object({
  fileName: z.string().min(1).max(255),
  label: z.string().min(1).max(200),
  contentBase64: z.string().min(1).max(40_000_000),
}).strict();

/** Required because `DocumentService.resubmit()` requires one — see the applicant route's own comment on why a UUID. */
function idempotencyKey(value: string | undefined): string {
  return parse(z.string().uuid('an Idempotency-Key must be a UUID'), value ?? null);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
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

/**
 * A refused action, as the officer needs to hear it.
 *
 * `422` rather than `409` for most of these: the request was well formed and
 * the caller was entitled to make it, but something about the application is
 * not yet true. That is a step to take, not a mistake to correct, and the two
 * send an officer to different places. The service's own `detail` is used
 * verbatim, because it knows which stage is next and which status the
 * application is actually in.
 */
function refusal(reason: string, detail: string): ProblemException {
  const status = reason === 'not-found'
    ? HttpStatus.NOT_FOUND
    : reason === 'self-review' || reason === 'self-verification'
      ? HttpStatus.FORBIDDEN
      : reason === 'already-decided' || reason === 'already-generated'
        || reason === 'already-released' || reason === 'already-assessed'
        || reason === 'already-verified' || reason === 'conflict'
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;

  const type = status === HttpStatus.NOT_FOUND
    ? ProblemType.notFound
    : status === HttpStatus.FORBIDDEN
      ? ProblemType.forbidden
      : status === HttpStatus.CONFLICT
        ? ProblemType.conflict
        : ProblemType.unprocessable;

  const title = status === HttpStatus.NOT_FOUND
    ? 'No such resource'
    : status === HttpStatus.FORBIDDEN
      ? 'Not permitted'
      : status === HttpStatus.CONFLICT
        ? 'The resource is not in a state that permits this'
        : 'A precondition is unmet';

  return new ProblemException(type, title, status, detail);
}

@Controller('staff/applications/:applicationId')
export class StaffActionsController {
  constructor(
    private readonly queue: StaffQueueService,
    private readonly evaluations: EvaluationService,
    private readonly assessment: AssessmentService,
    private readonly permits: PermitService,
    private readonly payments: PaymentService,
    private readonly documents: DocumentService,
    private readonly lifecycle: LifecycleService,
    private readonly logger: StructuredLogger,
  ) {}

  /** Readable and actionable are different questions; this answers the first. */
  private async visible(caller: Caller, applicationId: string): Promise<void> {
    if (await this.queue.detail(caller, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }
  }

  /**
   * The one place a stopped follow-on chain is written down. Logged rather
   * than thrown, for the reason `LifecycleService.followOn` gives; logged AT
   * ALL because the silent version of this pattern took real diagnostic
   * effort to notice was failing — nothing about a swallowed refusal was
   * visible anywhere until the data was read back by hand.
   */
  private noteFollowOn(what: string, applicationId: string, chain: FollowOnResult): void {
    if (chain.stoppedAt === null) return;
    this.logger.warn(`${what} recorded but the application did not advance to ${chain.stoppedAt.to}`, {
      applicationId, status: chain.status, refusal: chain.stoppedAt.refusal,
    });
  }

  @Post('evaluations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:evaluate')
  async evaluate(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(evaluationShape, body);
    await this.visible(caller, applicationId);

    const result = await this.evaluations.record({
      applicationId,
      stage: input.stage,
      result: input.result,
      evaluator: caller,
      ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    // `complete` is returned so the portal knows whether the application can now
    // be assessed, without a second request that would race the first.
    return { evaluationId: result.evaluationId, evaluationsComplete: result.complete };
  }

  /**
   * A staff verdict on one document — writes the columns migration 027
   * added. `documents:write` rather than a new `staff:*` scope: this is a
   * mutation of the document itself, the same authority `resubmitDocument`
   * acts under, not a lifecycle transition (nothing here moves
   * `lifecycle_status`).
   */
  @Post('documents/:documentId/review')
  @RequireScopes('documents:write')
  async reviewDocument(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(documentReviewShape, body);
    await this.visible(caller, applicationId);

    const result = await this.documents.review({
      applicationId,
      documentId,
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      remark: input.remark ?? null,
      caller,
    });

    if (!result.ok) {
      const detail =
        result.reason === 'not-found'
          ? 'No such document on this application.'
          : result.reason === 'not-scan-cleared'
            ? 'This document has not cleared the malware scan yet and cannot be reviewed.'
            : 'A reason is required when rejecting a document or requesting revision.';
      throw refusal(result.reason, detail);
    }
    return { ok: true };
  }

  /**
   * Resubmitting a rejected document for a citizen with no portal access.
   *
   * The applicant-only route (`POST /applications/:id/documents/:id/resubmit`)
   * is kind-gated, not merely scope-gated — a real, deliberate gap for a walk-in
   * who cannot resubmit themselves. This calls the exact same
   * `DocumentService.resubmit()` the applicant route does, with a staff
   * `Caller` instead: `uploaded_by` attributes the file to the officer who
   * actually handled it, which is the honest fact (they are the one who
   * scanned/typed the replacement in), not a fiction that the citizen
   * uploaded it themselves from a machine they were never at.
   */
  @Post('documents/:documentId/resubmit')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('documents:write')
  async resubmitDocument(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(documentResubmitShape, body ?? {});
    const idempotency = idempotencyKey(key);
    await this.visible(caller, applicationId);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.length === 0) throw new Error('empty');
    } catch {
      throw ProblemException.validation([
        { pointer: '/contentBase64', message: 'could not be decoded as base64' },
      ]);
    }

    const outcome = await this.documents.resubmit({
      applicationId, supersededDocumentId: documentId, bytes,
      fileName: input.fileName, label: input.label, caller,
      idempotencyKey: idempotency,
      digest: requestDigest(input),
    });

    switch (outcome.kind) {
      case 'created':
        return {
          documentId: outcome.documentId,
          supersedesDocumentId: documentId,
          status: outcome.status,
          removedMetadata: outcome.removedMetadata,
        };
      case 'replay':
        return outcome.body as Record<string, unknown>;
      case 'mismatch':
        throw new ProblemException(
          ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
          'This Idempotency-Key was already used for a different request. Use a new key.',
        );
      case 'refused':
        if (outcome.refusal.reason === 'not-found') {
          throw ProblemException.notFound('No such document on this application.');
        }
        throw new ProblemException(
          ProblemType.conflict, 'The resource is not in a state that permits this',
          HttpStatus.CONFLICT, outcome.refusal.detail,
        );
      default:
        if (outcome.infected) {
          throw new ProblemException(
            ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
            outcome.detail,
          );
        }
        throw ProblemException.validation([
          { pointer: '/contentBase64', message: outcome.detail },
        ]);
    }
  }

  @Post('order-of-payment')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:assess')
  async assess(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(orderOfPaymentShape, body ?? {});
    await this.visible(caller, applicationId);

    const result = await this.assessment.issue({
      applicationId,
      officer: caller,
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    });

    if (!result.ok) throw refusal(result.reason, result.detail);

    // Issuing the Order IS the assessment: `Under Evaluation -> Assessed`
    // requires exactly `evaluations-complete` (which `issue()` just
    // re-checked) and `order-of-payment-issued` (which is now true), under
    // the `staff:assess` scope this route already demands. Until now nothing
    // made that move, so an application with every stage passed and a real
    // Order in force still read "Under Evaluation" to every officer and
    // citizen, and the citizen could not pay — `Assessed -> Payment
    // Submitted` only starts from Assessed. The notification the transition
    // carries (`order-of-payment-issued`) is what tells the applicant a fee
    // is due, which is the other half of why this belongs here.
    const chain = await this.lifecycle.followOn({
      applicationId, hops: [{ caller, to: 'Assessed' }],
    });
    this.noteFollowOn('order of payment', applicationId, chain);
    return {
      orderId: result.orderId, number: result.number, totalCentavos: result.total,
      lifecycleStatus: chain.status,
    };
  }

  /**
   * Records a walk-in payment, receipted.
   *
   * Here rather than under `/staff/payments` because it CREATES a payment
   * against a named application rather than acting on one that already exists,
   * and a POST to a collection whose id you do not yet have is the wrong shape.
   */
  @Post('onsite-payment')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:verify-payment')
  async recordOnsite(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const input = parse(onsiteShape, body);
    const idempotencyKey = parse(z.string().uuid('an Idempotency-Key must be a UUID'), key ?? null);

    const cashier = callerOf(request);
    const result = await this.payments.recordOnsite({
      applicationId,
      cashier,
      officialReceiptNumber: input.officialReceiptNumber,
      amountCentavos: input.amountCentavos,
      idempotencyKey,
    });

    if (result.ok) {
      // The move this whole route exists to cause, mirroring
      // `ApplicantWriteController.pay()`'s own follow-on call. Recording the
      // payment above only ever wrote the `payments` row (same gap as
      // `submitProof()`) — without this, an application whose fee was
      // collected in person, receipted and already fully verified sat stuck
      // at Assessed forever, because `Assessed -> Payment Submitted` is
      // declared `actors: ['applicant']` in the lifecycle table and no staff
      // route could ever make that move. The citizen did not click anything,
      // but the citizen's money is the fact being recorded, so the first hop
      // is made AS the applicant — exactly as `payments` already records the
      // applicant, not the cashier, as this row's submitter. The next two
      // hops are the cashier's own act of verifying money they just counted.
      //
      // Skipped on a replay, same reasoning as the citizen controller: the
      // moves already happened on the original call.
      let lifecycleStatus: string | null = null;
      if (!result.replayed) {
        const asApplicant: Caller = {
          accountId: result.applicantAccountId, kind: 'applicant', scopes: ['payments:write'],
        };
        // Best-effort and never thrown on refusal (see `followOn`): the
        // payment row above is already committed. The last hop is new: a
        // verified payment has nothing left to wait for before the building
        // official's queue, and leaving it at Payment Verified meant a
        // "Send to Approval" click nobody knew they owed.
        const chain = await this.lifecycle.followOn({
          applicationId,
          hops: [
            { caller: asApplicant, to: 'Payment Submitted' },
            { caller: cashier, to: 'Payment Under Verification' },
            { caller: cashier, to: 'Payment Verified' },
            { caller: cashier, to: 'For Approval' },
          ],
        });
        this.noteFollowOn('onsite payment', applicationId, chain);
        lifecycleStatus = chain.status;
      }
      return { paymentId: result.paymentId, replayed: result.replayed, lifecycleStatus };
    }

    if (result.reason === 'self-receipt') {
      throw new ProblemException(
        ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
      );
    }
    if (result.reason === 'already-paid' || result.reason === 'conflict') {
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this',
        HttpStatus.CONFLICT, result.detail,
      );
    }
    // 422 for the rest: the request is well formed and the caller is entitled
    // to make it; something about the application is not yet true.
    throw new ProblemException(
      ProblemType.unprocessable, 'A precondition is unmet',
      HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
    );
  }

  @Post('permit')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:approve')
  async generatePermit(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(permitShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.generate({
      applicationId, officer: caller, scope: input.scope, conditions: input.conditions ?? [],
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    // `Approved -> Permit Generated` has exactly one precondition,
    // `permit-generated`, which the call above just made true — and the
    // transition is what notifies the applicant. Made here so every client
    // sees the same status, rather than each remembering to make the move.
    const chain = await this.lifecycle.followOn({
      applicationId, hops: [{ caller, to: 'Permit Generated' }],
    });
    this.noteFollowOn('permit', applicationId, chain);
    return { permitNumber: result.permitNumber, issuedDate: result.issuedDate, lifecycleStatus: chain.status };
  }

  @Post('release-preparation')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('staff:release')
  async prepareRelease(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(preparationShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.prepareRelease({
      applicationId, officer: caller,
      claimLocation: input.claimLocation, officeHours: input.officeHours,
      bringWithYou: input.bringWithYou ?? [],
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    // Preparing the release is what "Ready for Release" means; the transition
    // is what sends the applicant the claim instructions just recorded.
    const chain = await this.lifecycle.followOn({
      applicationId, hops: [{ caller, to: 'Ready for Release' }],
    });
    this.noteFollowOn('release preparation', applicationId, chain);
    return { prepared: true, lifecycleStatus: chain.status };
  }

  @Post('release')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('staff:release')
  async release(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = callerOf(request);
    const input = parse(releaseShape, body);
    await this.visible(caller, applicationId);

    const result = await this.permits.release({
      applicationId, officer: caller, claimantName: input.claimantName, method: input.method,
    });

    if (!result.ok) throw refusal(result.reason, result.detail);
    // The release just recorded satisfies `permit-released`; nothing further
    // happens to an application after its permit is in the claimant's hands,
    // so it is also Completed — the same two hops the portal used to make
    // itself, now made once, here, for every client.
    const chain = await this.lifecycle.followOn({
      applicationId, hops: [{ caller, to: 'Released' }, { caller, to: 'Completed' }],
    });
    this.noteFollowOn('release', applicationId, chain);
    return { releasedAt: result.releasedAt, lifecycleStatus: chain.status };
  }
}
