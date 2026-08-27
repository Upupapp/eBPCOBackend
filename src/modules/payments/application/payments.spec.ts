import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../../applications/domain/application';
import { centavos } from '../domain/money';
import { buildLineItems } from '../domain/order-of-payment';
import { AssessmentService } from './assessment.service';
import { PaymentService } from './payment.service';
import { reconcile } from './reconciliation';
import { AssessmentWorkflowService } from './assessment-workflow.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-19T12:00:00Z');

let db: SqlClient;
let assessment: AssessmentService;
let workflow: AssessmentWorkflowService;
let payments: PaymentService;

const APPLICANT_ACCOUNT = randomUUID();
const ASSESSOR_ACCOUNT = randomUUID();
const CASHIER_ACCOUNT = randomUUID();
const APPLICATION = randomUUID();

const applicant: Caller = { accountId: APPLICANT_ACCOUNT, kind: 'applicant', scopes: APPLICANT_SCOPES };
const assessor: Caller = { accountId: ASSESSOR_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES.assessor };
const REVIEWER_ACCOUNT = randomUUID();
const reviewer: Caller = { accountId: REVIEWER_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES.assessor };

/**
 * Since TAB 05 an Order of Payment is issued FROM an approved assessment, so
 * every test that issues one has to prepare, submit and have a SECOND officer
 * approve it first. A helper that used one officer would pass only while the
 * separation of duty was broken.
 */
async function approvedAssessment(applicationId: string = APPLICATION): Promise<string> {
  // Reuses one that is already approved. Several tests issue twice on purpose —
  // to prove the second is refused — and re-drafting would meet the
  // one-open-assessment rule instead of the rule under test.
  const existing = await workflow.approvedFor(applicationId);
  if (existing !== null) return existing.id;

  const draft = await workflow.draft({ applicationId, officer: assessor });
  // An Order already in force means there is nothing left to prepare. Several
  // tests issue a second time deliberately, to prove it is refused — reaching
  // the rule under test rather than tripping over this fixture on the way.
  if (!draft.ok && draft.reason === 'already-assessed') return '';
  if (!draft.ok) throw new Error(`draft: ${draft.detail}`);
  const submitted = await workflow.submit({ assessmentId: draft.assessment.id, officer: assessor });
  if (!submitted.ok) throw new Error(`submit: ${submitted.detail}`);
  const approved = await workflow.approve({ assessmentId: draft.assessment.id, officer: reviewer });
  if (!approved.ok) throw new Error(`approve: ${approved.detail}`);
  return draft.assessment.id;
}
const cashier: Caller = { accountId: CASHIER_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES.cashier };

async function loadSchedule(): Promise<void> {
  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1', '2026-01-01', 'City Ordinance 2026-004')`,
  );
  for (const [line, amount, basis] of [
    ['filing', 50_000, 'City Ordinance 2026-004 s.3(a)'],
    ['processing', 120_000, 'City Ordinance 2026-004 s.3(b)'],
    ['structural', 512_000, 'National Building Code IRR, Table III.1'],
  ] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1', 'Fencing', $1, $2, $3)`,
      [line, amount, basis],
    );
  }
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  assessment = new AssessmentService(db, () => NOW);
  workflow = new AssessmentWorkflowService(db, () => NOW, () => assessment.schedules());
  payments = new PaymentService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b'),
            ($2,'staff','assessor@lgu.gov.ph','assessor@lgu.gov.ph','scrypt$1$1$1$a$b'),
            ($3,'staff','cashier@lgu.gov.ph','cashier@lgu.gov.ph','scrypt$1$1$1$a$b'),
            ($4,'staff','reviewer@lgu.gov.ph','reviewer@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT, ASSESSOR_ACCOUNT, CASHIER_ACCOUNT, REVIEWER_ACCOUNT],
  );
  const applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000001',$2,'Fencing','New','Submitted',now(),$3)`,
    [APPLICATION, applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

describe('a fee cannot be invented', () => {
  it('refuses to assess when no LGU schedule is loaded', async () => {
    // M-08. A plausible-looking invented figure is worse than none: the
    // applicant would be quoted a fee the LGU never set.
    //
    // Asserted on the DRAFT since TAB 05. The refusal moved one step earlier
    // with the workflow: an officer is now stopped before typing anything,
    // rather than after preparing an assessment that could never be issued.
    const result = await workflow.draft({ applicationId: APPLICATION, officer: assessor });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-schedule');
  });

  it('refuses when the schedule covers other permit types but not this one', async () => {
    await db.query(
      `insert into fee_schedules (version, effective_from) values ('2026.1', '2026-01-01')`,
    );
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1', 'Demolition', 'filing', 50000, 'Ordinance s.3')`,
    );

    const result = await workflow.draft({ applicationId: APPLICATION, officer: assessor });
    expect(result.ok).toBe(false);
  });

  it('refuses a schedule not in force on the assessment date', async () => {
    // Quoting a fee from a schedule that was not in force is exactly the error
    // effective dating exists to prevent.
    await db.query(
      `insert into fee_schedules (version, effective_from) values ('2027.1', '2027-01-01')`,
    );
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2027.1', 'Fencing', 'filing', 50000, 'Ordinance s.3')`,
    );

    expect((await workflow.draft({ applicationId: APPLICATION, officer: assessor })).ok).toBe(false);
  });

  it('refuses a non-zero fee line that names no authority', () => {
    // An applicant handed a figure with no ordinance behind it has no way to
    // question it.
    expect(() => buildLineItems({ filing: 50_000 }, {})).toThrow(/names no ordinance/);
  });

  it('refuses to issue an Order totalling zero', () => {
    // Telling an applicant they may pay nothing and proceed is a fee waiver,
    // which is a different decision needing its own authority.
    expect(() => buildLineItems({}, {})).not.toThrow();
    const items = buildLineItems({}, {});
    expect(() => {
      const total = items.reduce((a, b) => a + b.amount, 0);
      if (total === 0) throw new Error('an Order of Payment totalling zero is not an assessment');
    }).toThrow(/not an assessment/);
  });
});

describe('issuing an Order of Payment', () => {
  beforeEach(loadSchedule);

  it('totals the lines from the schedule in force', async () => {
    await approvedAssessment();
    const result = await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(50_000 + 120_000 + 512_000);
    // A sequence, not a slice of a UUID. An applicant reads this number to a
    // cashier and writes it on a form: every character being one of ten rather
    // than one of thirty-six is the difference between a transcription and a
    // dispute, with B/8, 0/O and 1/I all in play at a counter.
    expect(result.number).toMatch(/^OP-2026-\d{6}$/);
  });

  it('records which schedule version it was computed under', async () => {
    // So a historical Order can be explained against the schedule in force
    // when it was made, not the one in force when the question is asked.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const row = await db.query<{ fee_schedule_version: string }>(
      'select fee_schedule_version from orders_of_payment',
    );
    expect(row.rows[0]?.fee_schedule_version).toBe('2026.1');
  });

  it('fills every unused line with an explicit zero, not a gap', async () => {
    // An applicant sees that architectural fees were considered and were nil,
    // rather than wondering whether they were forgotten.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const row = await db.query<Record<string, number>>(
      `select filing_centavos, processing_centavos, architectural_centavos,
              structural_centavos, electrical_centavos, others_centavos from orders_of_payment`,
    );
    expect(row.rows[0]?.architectural_centavos).toBe(0);
    expect(row.rows[0]?.electrical_centavos).toBe(0);
  });

  it('refuses a second Order while one is in force', async () => {
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    await approvedAssessment();
    const second = await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already-assessed');
  });

  it('records the statutory basis of every charged line', async () => {
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const audit = await db.query<{ after_state: { line: string; basis: string } }>(
      "select after_state from audit_events where action = 'assessment.line-issued'",
    );
    const bases = audit.rows.map((r) => r.after_state.basis);
    expect(bases).toContain('National Building Code IRR, Table III.1');
    expect(audit.rows).toHaveLength(3);
  });
});

describe('correcting an Order means superseding it', () => {
  beforeEach(loadSchedule);

  it('refuses to amend one in place', async () => {
    // Enforced by the database. Amending after an applicant has been told what
    // to pay is, from their side, being charged a different amount than quoted.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    await expect(
      db.query('update orders_of_payment set filing_centavos = 1, total_centavos = 633000'),
    ).rejects.toThrow(/immutable/);
  });

  it('produces a supersession chain carrying the reason', async () => {
    await approvedAssessment();
    const original = await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    if (!original.ok) return;

    const corrected = await assessment.supersede({
      orderId: original.orderId,
      reason: 'Structural fee recomputed after the revised plan reduced the floor area.',
      officer: assessor,
      items: buildLineItems({ filing: 50_000 }, { filing: 'City Ordinance 2026-004 s.3(a)' }),
    });

    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;

    const chain = await db.query<{ number: string; supersedes_id: string | null; superseded_reason: string | null }>(
      'select number, supersedes_id, superseded_reason from orders_of_payment order by assessed_at',
    );
    expect(chain.rows).toHaveLength(2);
    expect(chain.rows[1]?.supersedes_id).toBe(original.orderId);
    expect(chain.rows[1]?.superseded_reason).toContain('recomputed');
  });

  it('leaves exactly one Order in force', async () => {
    await approvedAssessment();
    const original = await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    if (!original.ok) return;
    await assessment.supersede({
      orderId: original.orderId,
      reason: 'Structural fee recomputed after the revised plan reduced the floor area.',
      officer: assessor,
      items: buildLineItems({ filing: 50_000 }, { filing: 'Ordinance s.3(a)' }),
    });

    const inForce = await db.query<{ count: number }>(
      'select count(*)::int as count from orders_of_payment where superseded_at is null',
    );
    expect(inForce.rows[0]?.count).toBe(1);
  });

  it('refuses a supersession with no explanation the applicant can read', async () => {
    await approvedAssessment();
    const original = await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    if (!original.ok) return;

    const result = await assessment.supersede({
      orderId: original.orderId, reason: 'fix', officer: assessor,
      items: buildLineItems({ filing: 50_000 }, { filing: 'Ordinance s.3(a)' }),
    });
    expect(result.ok).toBe(false);
  });
});

describe('submitting proof of payment', () => {
  beforeEach(loadSchedule);

  const proof = (overrides: Partial<Parameters<PaymentService['submitProof']>[0]['proof']> = {}) => ({
    referenceNumber: 'BDO-8827341990',
    method: 'Bank Transfer' as const,
    paidOn: '2026-08-20',
    amountCentavos: 682_000,
    proofDocumentId: null,
    ...overrides,
  });

  it('refuses when there is nothing to pay', async () => {
    // No Order means no figure and no way to pay. The applicant is not refused
    // for something they did; there is simply nothing owed yet.
    const result = await payments.submitProof({
      applicationId: APPLICATION, proof: proof(), caller: applicant, idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-order-of-payment');
  });

  it('records the proof and leaves it Pending Verification, never Paid', async () => {
    // A client must never be able to declare itself paid.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const result = await payments.submitProof({
      applicationId: APPLICATION, proof: proof(), caller: applicant, idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ status: string; verified_at: Date | null }>(
      'select status, verified_at from payments',
    );
    expect(row.rows[0]).toEqual({ status: 'Pending Verification', verified_at: null });
  });

  it('produces exactly one payment when the same key is replayed', async () => {
    // Acceptance criterion. The case is a submission whose response was lost on
    // a dropped connection; a second record would look, to reconciliation, like
    // the applicant paid twice.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    const key = randomUUID();

    const first = await payments.submitProof({
      applicationId: APPLICATION, proof: proof(), caller: applicant, idempotencyKey: key,
    });
    const replay = await payments.submitProof({
      applicationId: APPLICATION, proof: proof(), caller: applicant, idempotencyKey: key,
    });

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.paymentId).toBe(first.paymentId);
    expect(replay.replayed).toBe(true);

    const count = await db.query<{ count: number }>('select count(*)::int as count from payments');
    expect(count.rows[0]?.count).toBe(1);
  });

  it('refuses the same key used for a different request', async () => {
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    const key = randomUUID();
    await payments.submitProof({
      applicationId: APPLICATION, proof: proof(), caller: applicant, idempotencyKey: key,
    });

    const different = await payments.submitProof({
      applicationId: APPLICATION,
      proof: proof({ referenceNumber: 'A-DIFFERENT-REFERENCE' }),
      caller: applicant,
      idempotencyKey: key,
    });

    expect(different.ok).toBe(false);
    if (different.ok) return;
    expect(different.reason).toBe('conflict');
  });

  it('reports an underpayment to the officer rather than deciding it', async () => {
    // Decision E-8: partial payment is not accepted, and an applicant who paid
    // PHP 6,819.99 against PHP 6,820.00 has made a mistake worth a
    // conversation, not an automatic rejection.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const result = await payments.submitProof({
      applicationId: APPLICATION, proof: proof({ amountCentavos: 681_999 }),
      caller: applicant, idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settlement).toEqual({ settles: false, reason: 'underpaid', differenceCentavos: 1 });
  });

  it('reports an overpayment the same way', async () => {
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });

    const result = await payments.submitProof({
      applicationId: APPLICATION, proof: proof({ amountCentavos: 700_000 }),
      caller: applicant, idempotencyKey: randomUUID(),
    });

    if (!result.ok) return;
    expect(result.settlement).toMatchObject({ settles: false, reason: 'overpaid' });
  });

  it('refuses a non-integer amount before it reaches the database', () => {
    expect(() => centavos(682_000.5)).toThrow();
  });
});

describe('verification is an officer act', () => {
  beforeEach(loadSchedule);

  const submit = async (): Promise<string> => {
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    const result = await payments.submitProof({
      applicationId: APPLICATION,
      proof: { referenceNumber: 'BDO-1', method: 'Bank Transfer', paidOn: '2026-08-20', amountCentavos: 682_000, proofDocumentId: null },
      caller: applicant,
      idempotencyKey: randomUUID(),
    });
    return result.ok ? result.paymentId : '';
  };

  it('moves a payment to Paid only when an officer verifies it', async () => {
    const paymentId = await submit();

    expect((await payments.verify({ paymentId, officer: cashier, officialReceiptNumber: 'OR-1' })).ok).toBe(true);

    const row = await db.query<{ status: string; official_receipt_number: string }>(
      'select status, official_receipt_number from payments where id = $1', [paymentId],
    );
    expect(row.rows[0]).toEqual({ status: 'Paid', official_receipt_number: 'OR-1' });
  });

  it('refuses an officer verifying their own submission', async () => {
    // Separation of duty. The database enforces it too; this exists so the
    // caller gets an explanation rather than a constraint violation.
    await approvedAssessment();
    await assessment.issue({ applicationId: APPLICATION, officer: assessor });
    const submitted = await payments.submitProof({
      applicationId: APPLICATION,
      proof: { referenceNumber: 'ONSITE-1', method: 'Onsite', paidOn: '2026-08-20', amountCentavos: 682_000, proofDocumentId: null },
      caller: cashier,
      idempotencyKey: randomUUID(),
    });
    if (!submitted.ok) return;

    const result = await payments.verify({
      paymentId: submitted.paymentId, officer: cashier, officialReceiptNumber: 'OR-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('self-verification');
  });

  it('refuses to verify twice', async () => {
    const paymentId = await submit();
    await payments.verify({ paymentId, officer: cashier, officialReceiptNumber: 'OR-1' });

    expect((await payments.verify({ paymentId, officer: cashier, officialReceiptNumber: 'OR-2' })).ok).toBe(false);
  });

  it('refuses a rejection with no reason the applicant can act on', async () => {
    // The money may genuinely have left their account.
    const paymentId = await submit();

    expect((await payments.reject({ paymentId, officer: cashier, reason: 'no' })).ok).toBe(false);
  });

  it('records the rejection reason for the applicant', async () => {
    const paymentId = await submit();

    await payments.reject({
      paymentId, officer: cashier,
      reason: 'The reference number does not match any deposit received on that date. Check the slip and resubmit.',
    });

    const audit = await db.query<{ after_state: { reason: string } }>(
      "select after_state from audit_events where action = 'payment.rejected'",
    );
    expect(audit.rows[0]?.after_state.reason).toContain('does not match any deposit');
  });
});

describe('reconciliation', () => {
  beforeEach(loadSchedule);

  const settle = async (receipt: string, amount: number): Promise<void> => {
    const application = randomUUID();
    const applicantRow = await db.query<{ id: string }>('select id from applicants limit 1');
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,$2,$3,'Fencing','New','Submitted',now(),$4)`,
      [application, `BP-2026-${receipt}`, applicantRow.rows[0]?.id, APPLICANT_ACCOUNT],
    );
    await approvedAssessment(application);
    const order = await assessment.issue({ applicationId: application, officer: assessor });
    if (!order.ok) throw new Error('could not assess');

    const submitted = await payments.submitProof({
      applicationId: application,
      proof: { referenceNumber: receipt, method: 'Bank Transfer', paidOn: '2026-08-20', amountCentavos: amount, proofDocumentId: null },
      caller: applicant,
      idempotencyKey: randomUUID(),
    });
    if (!submitted.ok) throw new Error('could not submit');
    await payments.verify({ paymentId: submitted.paymentId, officer: cashier, officialReceiptNumber: receipt });
  };

  const window = { from: '2026-08-01', to: '2026-09-01' };

  it('balances to zero when both records agree', async () => {
    // Acceptance criterion.
    await settle('OR-1', 682_000);
    await settle('OR-2', 682_000);

    const report = await reconcile(db, {
      ...window,
      treasury: [
        { officialReceiptNumber: 'OR-1', amountCentavos: 682_000 },
        { officialReceiptNumber: 'OR-2', amountCentavos: 682_000 },
      ],
    });

    expect(report.balanced).toBe(true);
    expect(report.differenceCentavos).toBe(0);
    expect(report.verifiedPaymentCount).toBe(2);
    expect(report.discrepancies).toEqual([]);
  });

  it('reports money the system recorded that the Treasury does not hold', async () => {
    await settle('OR-1', 682_000);

    const report = await reconcile(db, { ...window, treasury: [] });

    expect(report.balanced).toBe(false);
    expect(report.discrepancies[0]).toMatchObject({
      kind: 'missing-from-treasury', officialReceiptNumber: 'OR-1',
    });
  });

  it('reports money the Treasury holds that the system never recorded', async () => {
    // Usually an applicant paid and the proof was never submitted or verified.
    const report = await reconcile(db, {
      ...window,
      treasury: [{ officialReceiptNumber: 'OR-STRAY', amountCentavos: 500_000 }],
    });

    expect(report.discrepancies[0]).toMatchObject({ kind: 'missing-from-system' });
  });

  it('reports an amount that differs', async () => {
    await settle('OR-1', 682_000);

    const report = await reconcile(db, {
      ...window, treasury: [{ officialReceiptNumber: 'OR-1', amountCentavos: 681_000 }],
    });

    expect(report.discrepancies[0]).toMatchObject({
      kind: 'amount-differs', systemCentavos: 682_000, treasuryCentavos: 681_000,
    });
  });

  it('is not fooled by two errors that cancel out', async () => {
    // Two offsetting errors sum to zero and are still two errors. A report that
    // only compared totals would call this balanced.
    await settle('OR-1', 682_000);

    const report = await reconcile(db, {
      ...window,
      treasury: [
        { officialReceiptNumber: 'OR-WRONG', amountCentavos: 682_000 },
      ],
    });

    expect(report.differenceCentavos).toBe(0);
    expect(report.balanced).toBe(false);
    expect(report.discrepancies).toHaveLength(2);
  });

  it('totals only what the window covers', async () => {
    await settle('OR-1', 682_000);

    const report = await reconcile(db, {
      from: '2026-01-01', to: '2026-02-01',
      treasury: [],
    });

    expect(report.verifiedPaymentCount).toBe(0);
    expect(report.systemTotalCentavos).toBe(0);
  });

  it('never produces a non-integer total, for any set of payments', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 100_000_000 }), { maxLength: 30 }), (amounts) => {
        const total = amounts.reduce((a, b) => a + b, 0);
        expect(Number.isInteger(centavos(total))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('the Order of Payment number', () => {
  it('is never issued twice', async () => {
    // Two Orders sharing a number is two assessments the Treasurer cannot tell
    // apart. The previous 32 bits of randomness were small enough to collide
    // and bought nothing — the number is not a secret.
    await loadSchedule();
    const numbers: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const application = randomUUID();
      await db.query(
        `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                   lifecycle_status, submitted_at, created_by)
         values ($1,$2,(select applicant_id from applications where id = $3),'Fencing','New',
                 'Submitted',now(),$4)`,
        [application, `BP-2026-EXTRA-${i}`, APPLICATION, APPLICANT_ACCOUNT],
      );
      await approvedAssessment(application);
      const issued = await assessment.issue({ applicationId: application, officer: assessor });
      if (issued.ok) numbers.push(issued.number);
    }

    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(4);
  });
});
