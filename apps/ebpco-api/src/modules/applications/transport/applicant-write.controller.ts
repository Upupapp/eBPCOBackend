import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../domain/application';
import { LifecycleService } from '../application/lifecycle.service';
import { InstructionResponseService } from '../application/instruction-response.service';
import { SubmissionService } from '../application/submission.service';
import { validateStructure } from '../domain/application-form';
import { ApplicantQueryService } from '../application/applicant-query.service';
import { PaymentService } from '../../payments/application/payment.service';
import { DocumentService } from '../../documents/application/document.service';
import { requestDigest } from '../../../persistence/idempotency';

/**
 * What an applicant WRITES.
 *
 * Separated from the read controller because these are the operations that
 * commit something, and every one of them carries an `Idempotency-Key`. That is
 * not uniformity for its own sake: the mobile client queues these offline and
 * replays them when a connection returns, so a replay is the normal case rather
 * than an edge one, and an endpoint here without a key is a duplicate filing
 * waiting for a dropped connection.
 */

const submissionShape = z.object({
  permitType: z.string().min(1).max(80),
  applicationAction: z.enum(['New', 'Renewal', 'Amendment']),
  /** The permit this renews, as printed on the applicant's copy. */
  renewsPermitNumber: z.string().min(1).max(60).nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  documentIds: z.array(z.string().uuid()).max(60).optional(),
  // Open by shape, bounded by size. The field SET is permit-type-specific and
  // has not been supplied (M-10); the structural limits below do not depend on
  // knowing it, and without them this endpoint accepts a ten-megabyte nested
  // object.
  form: z.record(z.string(), z.unknown()).optional(),
// `.strict()` on every write shape. A field the client sent and this server
// silently dropped is a field the client believes was honoured — and on a
// filing that could be a location, a business, or a document the applicant
// thinks they attached. `form` stays open on purpose: its field set is
// permit-type-specific and has not been supplied (M-10).
}).strict();

/**
 * Responding to a Letter of Instruction.
 *
 * The body is optional, and that is deliberate rather than lax. At a counter an
 * applicant hands back the corrected papers; they do not annotate each line of
 * the officer's note. Resubmitting IS the response, and the per-item text below
 * is for when the applicant wants to explain something — "sheet S-3 is now
 * signed, see the reuploaded plan".
 *
 * Resolving an item means the applicant has responded to it, not that the
 * officer accepted the response. The officer's re-evaluation is the check, and
 * conflating the two would let an officer's own backlog block an applicant from
 * replying.
 */
const resubmitShape = z.object({
  responses: z.array(z.object({
    itemId: z.string().uuid(),
    response: z.string().min(1).max(2000),
    documentId: z.string().uuid().nullable().optional(),
  }).strict()).max(50).optional(),
}).strict();

/**
 * Replacing one rejected document with a newly supplied file (D-8).
 *
 * The same three fields `POST /documents` takes, minus `applicationId`, which
 * is in the path and must not be contradictable by the body. `.strict()`, so a
 * client sending the old shape is told rather than silently having half its
 * request ignored.
 */
const documentResubmitShape = z.object({
  fileName: z.string().min(1).max(255),
  label: z.string().min(1).max(200),
  contentBase64: z.string().min(1).max(40_000_000),
}).strict();

const paymentShape = z.object({
  referenceNumber: z.string().min(1).max(80),
  method: z.enum(['Bank Transfer', 'Onsite']),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  amountCentavos: z.number().int().min(1),
  proofDocumentId: z.string().uuid().nullable().optional(),
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

function applicantCaller(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  if (claims.kind !== 'applicant') {
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN,
      'Officers act on applications through the staff surface.',
    );
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

/**
 * The key, required and validated as a UUID.
 *
 * A client-chosen string would work, and a UUID is required because the queue
 * generates one per attempt and a collision between two applicants' keys would
 * be a replay of someone else's request. The keys are account-scoped, so a
 * collision is not a disclosure — but a client sending `"1"` every time would
 * file once and then silently replay for ever.
 */
function idempotencyKey(value: string | undefined): string {
  return parse(z.string().uuid('an Idempotency-Key must be a UUID'), value ?? null);
}

@Controller()
export class ApplicantWriteController {
  constructor(
    private readonly submissions: SubmissionService,
    private readonly payments: PaymentService,
    private readonly lifecycle: LifecycleService,
    private readonly applications: ApplicantQueryService,
    private readonly instructions: InstructionResponseService,
    private readonly documents: DocumentService,
  ) {}

  @Post('applications')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('applications:write')
  async submit(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = applicantCaller(request);
    const input = parse(submissionShape, body);

    const form = input.form ?? {};
    const structural = validateStructure(form);
    if (structural.length > 0) {
      throw ProblemException.validation(structural.map((violation) => ({
        pointer: violation.pointer,
        message: violation.message,
      })));
    }

    const result = await this.submissions.submit({
      caller,
      idempotencyKey: idempotencyKey(key),
      submission: {
        permitType: input.permitType,
        applicationAction: input.applicationAction,
        businessId: input.businessId ?? null,
        location: input.location ?? null,
        renewsPermitNumber: input.renewsPermitNumber ?? null,
        documentIds: input.documentIds ?? [],
        form,
      },
    });

    if (!result.ok) {
      if (result.reason === 'form-rejected') {
        // 400 with field pointers, not 422. The answers are malformed rather
        // than the application being in the wrong state, and an applicant needs
        // to know WHICH field to go back to.
        throw ProblemException.validation((result.violations ?? []).map((violation) => ({
          pointer: violation.pointer,
          message: violation.message,
        })));
      }
      if (result.reason === 'key-reused') {
        throw new ProblemException(
          ProblemType.conflict, 'The resource is not in a state that permits this',
          HttpStatus.CONFLICT, result.detail,
        );
      }
      // 422 for the rest: the request was well formed and the caller was
      // entitled to make it, but something about the state is not true yet.
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }

    // The whole application back, through the applicant projection — so the
    // client has the same shape it would get from a GET and does not have to
    // build a half-record from a creation response.
    const view = await this.applications.byId(caller.accountId, result.applicationId);
    return view ?? { id: result.applicationId, referenceNumber: result.referenceNumber };
  }

  @Post('applications/:applicationId/payments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('payments:write')
  async pay(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = applicantCaller(request);
    const input = parse(paymentShape, body);

    // Yours to pay against, or 404. Checked here rather than left to the
    // payment service, which is written for officers too and does not scope by
    // applicant.
    if (await this.applications.byId(caller.accountId, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }

    const result = await this.payments.submitProof({
      applicationId,
      caller,
      idempotencyKey: idempotencyKey(key),
      proof: {
        referenceNumber: input.referenceNumber,
        method: input.method,
        paidOn: input.paidOn,
        amountCentavos: input.amountCentavos,
        proofDocumentId: input.proofDocumentId ?? null,
      },
    });

    if (result.ok) {
      return { paymentId: result.paymentId, replayed: result.replayed, settles: result.settlement.settles };
    }

    if (result.reason === 'no-order-of-payment') {
      // Not 404 and not 400. The application exists and the request is well
      // formed; what is missing is an Order of Payment, and telling the
      // applicant that specifically is the difference between them waiting and
      // them calling the LGU.
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }
    throw new ProblemException(
      ProblemType.conflict, 'The resource is not in a state that permits this',
      HttpStatus.CONFLICT, result.detail,
    );
  }

  /**
   * Replacing one document on a filed application (D-8).
   *
   * The mobile client has called this route since before it existed; it
   * returned 404, and the client's own comment recorded that as a hand-off
   * rather than faking a success. This is it.
   *
   * APPENDS, never overwrites. The replacement is a new row pointing at what it
   * replaces, so the old document keeps its rejection and the reason given for
   * it -- which is exactly the pair that makes a rejection actionable, and
   * which `GET /applications/:id/documents` now shows the applicant.
   *
   * It does NOT move the application. Responding to a Letter of Instruction is
   * what returns an application to Under Evaluation, and it already does that
   * in one transaction; a second route making the same transition would be two
   * paths to one state, disagreeing the first time either changed.
   */
  @Post('applications/:applicationId/documents/:documentId/resubmit')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('documents:write')
  async resubmitDocument(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = applicantCaller(request);
    const input = parse(documentResubmitShape, body ?? {});
    const idempotency = idempotencyKey(key);

    // Ownership first, and the same 404 the detail gives: a document id that
    // behaves differently on someone else's application is a way to learn that
    // the application exists.
    if (await this.applications.byId(caller.accountId, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }

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
      // The file itself is part of the fingerprint. Two different replacements
      // sent under one key are two different requests, and answering the second
      // with the first's document id would tell an applicant the wrong file is
      // now on their application.
      digest: requestDigest(input),
    });

    switch (outcome.kind) {
      case 'created':
        return {
          documentId: outcome.documentId,
          supersedesDocumentId: documentId,
          status: outcome.status,
          // Same as the upload route: an applicant is entitled to know the LGU
          // stripped the GPS coordinates out of their site photograph.
          removedMetadata: outcome.removedMetadata,
        };

      case 'replay':
        // The same answer as the first time, not a second document. This is
        // the case a dropped connection produces, and reporting a conflict for
        // one's own success is exactly what the key exists to prevent.
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

  /**
   * Responding to a Letter of Instruction and putting the application back in
   * front of an officer.
   *
   * Two things in one transaction, because they are one act: the items are
   * marked responded to, and the application moves back to Under Evaluation.
   * Split, a crash between them leaves an applicant who has answered
   * everything sitting in Revision Required with nothing to do.
   */
  @Post('applications/:applicationId/instructions/:letterId/resubmit')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('applications:write')
  async resubmit(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('letterId') letterId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = applicantCaller(request);
    const input = parse(resubmitShape, body ?? {});
    const idempotency = idempotencyKey(key);

    if (await this.applications.byId(caller.accountId, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }

    const resolved = await this.instructions.respond({
      applicationId, letterId, caller, responses: input.responses ?? [],
    });

    if (!resolved.ok) {
      if (resolved.reason === 'not-found') throw ProblemException.notFound(resolved.detail);
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet',
        HttpStatus.UNPROCESSABLE_ENTITY, resolved.detail,
      );
    }

    const moved = await this.lifecycle.transition({
      applicationId, caller, to: 'Under Evaluation', idempotencyKey: idempotency,
    });

    if (moved.ok) return { status: moved.status, version: moved.version, resolved: resolved.resolved };
    if ('reused' in moved) {
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }
    throw new ProblemException(
      ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
      'This application is not waiting on a response from you.',
    );
  }

  /**
   * Withdrawing an application.
   *
   * Allowed only before an Order of Payment exists (decision E-4). Past that
   * point cancelling touches money the applicant may already have transferred,
   * and unwinding it is a treasury operation rather than a button. The
   * lifecycle table enforces this; the endpoint just asks.
   */
  @Post('applications/:applicationId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('applications:write')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<Record<string, unknown>> {
    const caller = applicantCaller(request);
    const reason = parse(z.object({ reason: z.string().max(2000).optional() }), body ?? {});

    if (await this.applications.byId(caller.accountId, applicationId) === null) {
      throw ProblemException.notFound('No such application.');
    }

    const result = await this.lifecycle.transition({
      applicationId,
      caller,
      to: 'Cancelled',
      idempotencyKey: idempotencyKey(key),
      ...(reason.reason === undefined ? {} : { remarks: reason.reason }),
    });

    if (result.ok) return { status: result.status, version: result.version };
    if ('reused' in result) {
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }
    // Both refusals mean the same thing HERE, and that is worth spelling out.
    // `illegal-transition` is a status with no route to Cancelled at all.
    // `not-permitted` is a route that exists but is staff-only — which past an
    // Order of Payment is exactly the E-4 boundary, because the applicant is
    // the wrong actor rather than the move being impossible.
    //
    // Treating only the first specially left an applicant with "This
    // application cannot be withdrawn", which is true and tells them nothing
    // about what to do next.
    if (result.refusal.kind === 'illegal-transition' || result.refusal.kind === 'not-permitted') {
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
        `An application at ${result.refusal.from} can no longer be withdrawn here. `
        + 'Once fees have been assessed, withdrawing it is a treasury matter — contact the LGU.',
      );
    }
    throw new ProblemException(
      ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT,
      'This application cannot be withdrawn.',
    );
  }
}
