import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { centavos, parseCentavos } from '../domain/money';
import { SettlementCheck, checkSettles } from '../domain/order-of-payment';
import { requestDigest } from './assessment.service';

/**
 * Submitting proof of payment, and verifying it.
 *
 * The rule this class exists to hold: **submitting proof sets Payment
 * Submitted, never Paid.** Only an officer's verification reaches Paid, and the
 * database enforces both that (`paid_requires_verification`) and that the
 * officer verifying is not the one who submitted
 * (`verifier_is_not_the_submitter`). A client must never be able to declare
 * itself paid.
 */

export type PaymentMethod = 'Bank Transfer' | 'Onsite';

export interface PaymentProof {
  readonly referenceNumber: string;
  readonly method: PaymentMethod;
  readonly paidOn: string;
  readonly amountCentavos: number;
  readonly proofDocumentId: string | null;
}

export type SubmitResult =
  | { readonly ok: true; readonly paymentId: string; readonly replayed: boolean; readonly settlement: SettlementCheck }
  | { readonly ok: false; readonly reason: 'no-order-of-payment' | 'already-verified' | 'conflict'; readonly detail: string };

export type VerifyResult =
  | { readonly ok: true; readonly paymentId: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'self-verification' | 'already-verified'; readonly detail: string };

export class PaymentService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * Records proof of payment, exactly once per idempotency key.
   *
   * The case this exists for is a submission whose response was lost on a
   * dropped mobile connection. Replaying must return the original result, not
   * post a second payment against the same Order — which would look, to
   * reconciliation, like the applicant paid twice.
   */
  async submitProof(options: {
    applicationId: string;
    proof: PaymentProof;
    caller: Caller;
    idempotencyKey: string;
  }): Promise<SubmitResult> {
    const { applicationId, proof, caller, idempotencyKey } = options;
    const digest = requestDigest({ applicationId, ...proof });

    const replay = await this.db.query<{ response_body: { paymentId: string }; request_digest: string }>(
      `select response_body, request_digest from idempotency_keys
        where account_id = $1 and key = $2 and operation = 'payment.submit'`,
      [caller.accountId, idempotencyKey],
    );
    const previous = replay.rows[0];
    if (previous !== undefined) {
      if (previous.request_digest !== digest) {
        // The same key with a different body is a client bug, and honouring it
        // would either post a payment the caller thinks was already made or
        // return a result for a different request.
        return {
          ok: false,
          reason: 'conflict',
          detail: 'this idempotency key was used for a different request',
        };
      }
      return {
        ok: true,
        paymentId: previous.response_body.paymentId,
        replayed: true,
        settlement: { settles: true },
      };
    }

    const order = await this.db.query<{ id: string; total_centavos: number }>(
      `select id, total_centavos from orders_of_payment
        where application_id = $1 and superseded_at is null`,
      [applicationId],
    );
    const inForce = order.rows[0];
    if (inForce === undefined) {
      // No Order means no figure and no way to pay. The applicant is not
      // refused for something they did; there is simply nothing owed yet.
      return {
        ok: false,
        reason: 'no-order-of-payment',
        detail: 'No Order of Payment has been issued for this application, so there is nothing to pay.',
      };
    }

    const alreadyVerified = await this.db.query<{ id: string }>(
      'select id from payments where application_id = $1 and verified_at is not null',
      [applicationId],
    );
    if (alreadyVerified.rows.length > 0) {
      return { ok: false, reason: 'already-verified', detail: 'this application has already been paid' };
    }

    const amount = centavos(proof.amountCentavos);
    const settlement = checkSettles(parseCentavos(inForce.total_centavos), amount);

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `insert into payments (order_of_payment_id, application_id, reference_number, amount_centavos,
                               method, status, proof_document_id, submitted_at, submitted_by)
         values ($1,$2,$3,$4,$5,'Pending Verification',$6,$7,$8)
         returning id`,
        [inForce.id, applicationId, proof.referenceNumber, amount, proof.method,
         proof.proofDocumentId, this.clock(), caller.accountId],
      );
      const paymentId = inserted.rows[0]?.id ?? '';

      await tx.query(
        `insert into idempotency_keys (key, account_id, operation, request_digest, response_status, response_body)
         values ($1,$2,'payment.submit',$3,200,$4)`,
        [idempotencyKey, caller.accountId, digest, JSON.stringify({ paymentId })],
      );

      return { ok: true, paymentId, replayed: false, settlement };
    });
  }

  /**
   * An officer confirms the money arrived.
   *
   * Separation of duty is enforced by the database, not here — but it is
   * checked here too so the caller gets an explanation rather than a constraint
   * violation.
   */
  async verify(options: {
    paymentId: string;
    officer: Caller;
    officialReceiptNumber: string;
  }): Promise<VerifyResult> {
    const { paymentId, officer, officialReceiptNumber } = options;

    const payment = await this.db.query<{ submitted_by: string; verified_at: Date | null }>(
      'select submitted_by, verified_at from payments where id = $1',
      [paymentId],
    );
    const row = payment.rows[0];
    if (row === undefined) return { ok: false, reason: 'not-found', detail: 'no such payment' };
    if (row.verified_at !== null) {
      return { ok: false, reason: 'already-verified', detail: 'this payment has already been verified' };
    }
    if (row.submitted_by === officer.accountId) {
      // The officer who recorded an onsite payment must not also confirm it.
      return {
        ok: false,
        reason: 'self-verification',
        detail: 'the officer who submitted a payment may not verify it',
      };
    }

    await this.db.query(
      `update payments
          set status = 'Paid', verified_at = $1, verified_by = $2, official_receipt_number = $3
        where id = $4`,
      [this.clock(), officer.accountId, officialReceiptNumber, paymentId],
    );

    return { ok: true, paymentId };
  }

  /**
   * An officer rejects proof.
   *
   * The reason is required and travels to the applicant verbatim: "payment
   * rejected" with no explanation leaves them unable to fix it, and the money
   * may genuinely have left their account.
   */
  async reject(options: { paymentId: string; officer: Caller; reason: string }): Promise<VerifyResult> {
    const { paymentId, officer, reason } = options;
    if (reason.trim().length < 10) {
      return { ok: false, reason: 'not-found', detail: 'a rejection must state a reason the applicant can act on' };
    }

    const updated = await this.db.query(
      `update payments set status = 'Not Yet Available' where id = $1 and verified_at is null`,
      [paymentId],
    );
    if (updated.rowCount === 0) return { ok: false, reason: 'not-found', detail: 'no unverified payment with that id' };

    await this.audit.append({
      action: 'payment.rejected',
      subjectType: 'payment',
      subjectId: paymentId,
      outcome: 'allowed',
      actorAccountId: officer.accountId,
      actorRole: officer.kind,
      // Verbatim, and it travels to the applicant: the money may genuinely have
      // left their account and "rejected" with no reason is unactionable.
      afterState: { reason },
    });

    return { ok: true, paymentId };
  }
}
