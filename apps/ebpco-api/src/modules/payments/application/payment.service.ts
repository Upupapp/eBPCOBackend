import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { centavos, parseCentavos } from '../domain/money';
import { SettlementCheck, checkSettles } from '../domain/order-of-payment';
import { requestDigest } from './assessment.service';
import { lookup, remember } from '../../../persistence/idempotency';

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
  | { readonly ok: false; readonly reason: 'no-order-of-payment' | 'already-verified' | 'conflict' | 'method-closed'; readonly detail: string };

export type RecordOnsiteResult =
  | { readonly ok: true; readonly paymentId: string; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly reason: 'no-order-of-payment' | 'already-paid' | 'does-not-settle'
        | 'self-receipt' | 'conflict';
      readonly detail: string;
    };

export type VerifyResult =
  | { readonly ok: true; readonly paymentId: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'self-verification' | 'already-verified' | 'invalid' | 'not-permitted'; readonly detail: string };

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

    // Checked here rather than only in the UI. An LGU that closes a method has
    // closed it — a client with a stale form, or one that never asked, must not
    // be able to lodge a payment through a channel nobody is watching.
    const open = await this.db.query<{ active: boolean }>(
      'select active from payment_methods where method = $1', [proof.method],
    );
    if (open.rows[0]?.active !== true) {
      return {
        ok: false, reason: 'method-closed',
        detail: `The LGU is not accepting ${proof.method} payments at the moment.`,
      };
    }

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
   * Cash across a counter.
   *
   * The applicant hands over money and the cashier issues an Official Receipt.
   * That is one act, not two, and modelling it as "record, then have somebody
   * else verify" would ask an officer to confirm money they never handled.
   *
   * **The submitter is the APPLICANT, not the cashier.** That is not a
   * workaround for `verifier_is_not_the_submitter` — it is what happened. The
   * applicant paid; the cashier received it and receipted it. Recording the
   * cashier as submitter would be recording them as having paid their own
   * LGU's fee, which is both false and would collapse the two roles the
   * constraint exists to keep apart.
   *
   * The constraint then does something useful for free: where the cashier IS
   * the applicant — staff do apply for permits on their own houses — the two
   * account ids are equal and the insert is refused. A cashier must not
   * receipt their own permit fee, and nobody had to write that rule.
   *
   * Who recorded it is not lost: the audit entry names the cashier, and that is
   * the right place for it, since it is a fact about the LGU's handling rather
   * than about the payment.
   */
  async recordOnsite(options: {
    applicationId: string;
    cashier: Caller;
    officialReceiptNumber: string;
    amountCentavos: number;
    idempotencyKey: string;
  }): Promise<RecordOnsiteResult> {
    const { applicationId, cashier, officialReceiptNumber, amountCentavos, idempotencyKey } = options;
    const digest = requestDigest({ applicationId, officialReceiptNumber, amountCentavos });

    return this.db.transaction(async (tx) => {
      const replay = await lookup<{ paymentId: string }>(tx, {
        accountId: cashier.accountId, key: idempotencyKey,
        operation: 'payment.record-onsite', digest,
      });
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'conflict',
          detail: 'This Idempotency-Key was already used for a different receipt. Use a new key.',
        };
      }
      if (replay.kind === 'replay') {
        return { ok: true, paymentId: replay.previous.body.paymentId, replayed: true };
      }

      const context = await tx.query<{
        order_id: string; total_centavos: string; applicant_account_id: string; already_paid: boolean;
      }>(
        `select o.id as order_id, o.total_centavos, acc.id as applicant_account_id,
                exists (select 1 from payments p
                         where p.application_id = a.id and p.verified_at is not null) as already_paid
           from applications a
           join applicants ap on ap.id = a.applicant_id
           join accounts acc on acc.id = ap.account_id
           join orders_of_payment o
             on o.application_id = a.id and o.superseded_at is null
          where a.id = $1
          for update of a`,
        [applicationId],
      );
      const row = context.rows[0];
      if (row === undefined) {
        // No Order of Payment means nothing to receipt. Saying that
        // specifically is the difference between the cashier waiting and the
        // cashier telephoning the assessor.
        return {
          ok: false, reason: 'no-order-of-payment',
          detail: 'No Order of Payment has been issued for this application, so there is nothing to pay.',
        };
      }
      if (row.already_paid) {
        return {
          ok: false, reason: 'already-paid',
          detail: 'A verified payment is already recorded against this application.',
        };
      }
      if (row.applicant_account_id === cashier.accountId) {
        // The database would refuse this anyway. Answering here says why.
        return {
          ok: false, reason: 'self-receipt',
          detail: 'You cannot receipt a payment on your own application. Ask a colleague.',
        };
      }

      const total = parseCentavos(row.total_centavos);
      const settlement = checkSettles(total, centavos(amountCentavos));
      if (!settlement.settles) {
        // ADR 0010: no partial payments. An LGU that accepts part of a fee has
        // to track a balance, chase it, and decide what a half-paid permit is —
        // and none of that is built or decided.
        return {
          ok: false, reason: 'does-not-settle',
          detail: `The Order of Payment is for ${total} centavos and this receipt is for `
            + `${amountCentavos}. Partial payments are not accepted.`,
        };
      }

      const now = this.clock();
      const inserted = await tx.query<{ id: string }>(
        `insert into payments
           (order_of_payment_id, application_id, reference_number, amount_centavos, method, status,
            submitted_at, submitted_by, verified_at, verified_by, official_receipt_number)
         values ($1,$2,$3,$4,'Onsite','Paid',$5,$6,$5,$7,$8)
         returning id`,
        [row.order_id, applicationId, officialReceiptNumber, total, now,
         row.applicant_account_id, cashier.accountId, officialReceiptNumber],
      );
      const paymentId = inserted.rows[0]?.id ?? '';

      await this.audit.append({
        action: 'payment.recorded-onsite',
        subjectType: 'payment',
        subjectId: paymentId,
        outcome: 'allowed',
        // The cashier, not the applicant. Who handled the money is a fact about
        // the LGU's handling, and this is where it belongs.
        actorAccountId: cashier.accountId,
        afterState: { applicationId, officialReceiptNumber, amountCentavos: total },
      }, tx);

      await remember(tx, {
        accountId: cashier.accountId, key: idempotencyKey,
        operation: 'payment.record-onsite', digest, status: 201, body: { paymentId },
      });

      return { ok: true, paymentId, replayed: false };
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
  /**
   * Undoing a payment, in one of three ways that mean different things.
   *
   * ── Which one, and why it matters ───────────────────────────────────────
   *
   * VOID is for a record that should never have existed — entered against the
   * wrong application, or twice. Nothing was confirmed, so nothing about money
   * is being asserted. Only a payment that has NOT been verified can be voided:
   * once an officer has confirmed money arrived, saying the record was a
   * clerical slip is a different claim, and a false one.
   *
   * REVERSE is for a payment confirmed as Paid whose money never actually
   * arrived — a bounced cheque, a transfer that failed after the officer saw
   * the proof. The LGU holds nothing and is still owed the fee.
   *
   * REFUND is for money that DID arrive and is being returned: a superseded
   * assessment reduced the fee, the application was withdrawn. The LGU held it
   * and no longer should.
   *
   * Reverse and refund look alike in a list and mean opposite things about who
   * is out of pocket, which is why they are separate acts with separate names
   * rather than one flag.
   *
   * ── What this does NOT do ───────────────────────────────────────────────
   *
   * It does not move the application. Reversing a payment on an application
   * sitting at Payment Verified leaves it there, and an officer has to move it
   * back through the transition table — which is the only thing that knows
   * which moves are legal from where. Driving a transition from here would be a
   * second lifecycle engine written by someone thinking about money.
   *
   * A permit already generated is refused outright. Money for an instrument the
   * applicant is holding is a different problem, and one this route quietly
   * resolving would be worse than one it declines.
   */
  async undo(options: {
    paymentId: string;
    kind: 'Voided' | 'Reversed' | 'Refunded';
    officer: Caller;
    reason: string;
  }): Promise<VerifyResult> {
    const { paymentId, kind, officer, reason } = options;

    if (reason.trim().length < 10) {
      return {
        ok: false, reason: 'invalid',
        detail: 'Undoing a payment requires a stated reason an applicant can be told.',
      };
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(paymentId)) {
      return { ok: false, reason: 'not-found', detail: 'No such payment.' };
    }

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{
        id: string; status: string; application_id: string; verified_by: string | null;
        has_permit: boolean;
      }>(
        `select p.id, p.status, p.application_id, p.verified_by,
                exists (select 1 from generated_permits g where g.application_id = p.application_id)
                  as has_permit
           from payments p where p.id = $1 for update`,
        [paymentId],
      );
      const payment = found.rows[0];
      if (payment === undefined) {
        return { ok: false, reason: 'not-found', detail: 'No such payment.' };
      }

      if (payment.has_permit) {
        return {
          ok: false, reason: 'invalid',
          detail: 'A permit has already been generated from this application. Undoing its payment '
            + 'here would leave an issued instrument with no settled fee behind it.',
        };
      }

      const settled = payment.status === 'Paid';
      if (kind === 'Voided' && settled) {
        return {
          ok: false, reason: 'invalid',
          detail: 'This payment has been verified as Paid, so it cannot be voided as a clerical '
            + 'error. Reverse it if the money never arrived, or refund it if it did.',
        };
      }
      if (kind !== 'Voided' && !settled) {
        return {
          ok: false, reason: 'invalid',
          detail: `This payment is ${payment.status}, not Paid. Void it instead — there is no `
            + 'settlement to reverse or refund.',
        };
      }
      if (kind !== 'Voided' && payment.verified_by === officer.accountId) {
        // The officer who confirmed the money arrived may not be the one who
        // says it did not, or who sends it back. Undoing your own confirmation
        // alone is the same weakness the verifier/submitter rule already
        // refuses one step earlier.
        return {
          ok: false, reason: 'not-permitted',
          detail: 'An officer may not reverse or refund a payment they verified. '
            + 'Ask another officer.',
        };
      }

      await tx.query(
        `update payments set status = $1, exception_reason = $2, exception_at = $3, exception_by = $4
          where id = $5`,
        [kind, reason.trim(), this.clock(), officer.accountId, paymentId],
      );

      await this.audit.append({
        action: `payment.${kind.toLowerCase()}`,
        subjectType: 'payment',
        subjectId: paymentId,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        beforeState: { status: payment.status, verifiedBy: payment.verified_by },
        afterState: { status: kind, reason: reason.trim() },
      }, tx);

      return { ok: true, paymentId };
    });
  }

  /**
   * Corrects the Official Receipt number on a settled payment.
   *
   * Not a second way to verify: the payment is already Paid and already carries
   * a number, because `settled_requires_verification` refuses a settled payment
   * without one. This is for the number being WRONG — transposed at a counter,
   * read off the wrong stub — which is a correction to the LGU's own record of
   * a receipt the applicant is holding, so it needs a reason and an audit entry
   * naming the officer, exactly as any other correction does.
   */
  async correctReceipt(options: {
    paymentId: string; officer: Caller; officialReceiptNumber: string; reason: string;
  }): Promise<VerifyResult> {
    const { paymentId, officer, officialReceiptNumber, reason } = options;

    if (reason.trim().length < 10) {
      return {
        ok: false, reason: 'invalid',
        detail: 'Correcting a receipt number requires a stated reason.',
      };
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(paymentId)) {
      return { ok: false, reason: 'not-found', detail: 'No such payment.' };
    }

    return this.db.transaction(async (tx) => {
      const found = await tx.query<{ status: string; official_receipt_number: string | null }>(
        'select status, official_receipt_number from payments where id = $1 for update',
        [paymentId],
      );
      const payment = found.rows[0];
      if (payment === undefined) {
        return { ok: false, reason: 'not-found', detail: 'No such payment.' };
      }
      if (payment.status !== 'Paid') {
        return {
          ok: false, reason: 'invalid',
          detail: `This payment is ${payment.status}. A receipt number belongs to a settled payment; `
            + 'verify it first.',
        };
      }
      if (payment.official_receipt_number === officialReceiptNumber.trim()) {
        return { ok: true, paymentId };
      }

      await tx.query(
        'update payments set official_receipt_number = $1 where id = $2',
        [officialReceiptNumber.trim(), paymentId],
      );
      await this.audit.append({
        action: 'payment.receipt-corrected',
        subjectType: 'payment',
        subjectId: paymentId,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        beforeState: { officialReceiptNumber: payment.official_receipt_number },
        afterState: { officialReceiptNumber: officialReceiptNumber.trim(), reason: reason.trim() },
      }, tx);

      return { ok: true, paymentId };
    });
  }

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
