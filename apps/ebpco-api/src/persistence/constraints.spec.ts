import { join } from 'node:path';

import { PgliteClient } from './pglite-client';
import { SqlClient } from './sql-client';
import { loadMigrations, migrate } from './migrator';

/**
 * What the DATABASE refuses, regardless of what any service believes.
 *
 * These are the TAB 04 acceptance criteria, and they run against real
 * PostgreSQL. The distinction being tested is not pedantry: both clients
 * advanced application status locally before this programme began, and the
 * lifecycle engine in TAB 05 will enforce the same rules in application code.
 * A rule enforced only there is a rule that a migration script, a psql session,
 * a reporting job or a second service can walk straight past.
 */

const MIGRATIONS_DIR = join(__dirname, '../../db/migrations');

let db: SqlClient;

/** Ids for a minimal, valid world: one staff account, one applicant, one application. */
const OFFICER = '11111111-1111-4111-8111-111111111111';
const ASSESSOR = '22222222-2222-4222-8222-222222222222';
const CITIZEN = '33333333-3333-4333-8333-333333333333';
const APPLICANT = '44444444-4444-4444-8444-444444444444';
const APPLICATION = '55555555-5555-4555-8555-555555555555';

async function seedWorld(): Promise<void> {
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1, 'staff', 'officer@lgu.gov.ph', 'officer@lgu.gov.ph', 'scrypt$1$1$1$a$b'),
            ($2, 'staff', 'assessor@lgu.gov.ph', 'assessor@lgu.gov.ph', 'scrypt$1$1$1$a$b'),
            ($3, 'applicant', 'maria@example.ph', 'maria@example.ph', 'scrypt$1$1$1$a$b')`,
    [OFFICER, ASSESSOR, CITIZEN],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1, $2, 'Maria', 'Santos')`,
    [APPLICANT, CITIZEN],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1, 'BP-2026-000001', $2, 'Fencing Permit', 'New', 'Submitted', now(), $3)`,
    [APPLICATION, APPLICANT, CITIZEN],
  );
}

const setStatus = (status: string) =>
  db.query('update applications set lifecycle_status = $1, updated_by = $2 where id = $3', [
    status,
    OFFICER,
    APPLICATION,
  ]);

/** Walks the application forward through legal moves only. */
async function advanceTo(target: string): Promise<void> {
  const path: Record<string, string[]> = {
    Assessed: ['Received', 'Document Verification', 'Under Evaluation', 'Assessed'],
    'Ready for Release': [
      'Received', 'Document Verification', 'Under Evaluation', 'Assessed',
      'Payment Submitted', 'Payment Under Verification', 'Payment Verified',
      'For Approval', 'Approved', 'Permit Generated', 'Ready for Release',
    ],
  };
  for (const status of path[target] ?? []) await setStatus(status);
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  await seedWorld();
});
afterEach(async () => {
  await db.close();
});

describe('the lifecycle is enforced by the database', () => {
  it('permits a legal transition', async () => {
    await expect(setStatus('Received')).resolves.toBeDefined();
  });

  it('REFUSES an illegal transition', async () => {
    // Submitted -> Released would issue a permit for an application nobody
    // evaluated, assessed, or was paid for.
    await expect(setStatus('Released')).rejects.toThrow(/illegal lifecycle transition/);
  });

  it.each([
    ['Submitted', 'Approved'],
    ['Submitted', 'Permit Generated'],
    ['Submitted', 'Payment Verified'],
    ['Submitted', 'Completed'],
  ])('refuses %s -> %s', async (_from, to) => {
    await expect(setStatus(to)).rejects.toThrow(/illegal lifecycle transition/);
  });

  it('refuses a status that is not in the vocabulary at all', async () => {
    await expect(setStatus('Under Appeal')).rejects.toThrow();
  });

  it('lets a terminal status be reached but never left', async () => {
    await setStatus('Cancelled');
    await expect(setStatus('Received')).rejects.toThrow(/illegal lifecycle transition/);
  });

  it('refuses to create an application already in flight', async () => {
    // Otherwise an insert could place a record straight into 'Approved' and
    // skip every check above.
    await expect(
      db.query(
        `insert into applications (reference_number, applicant_id, permit_type, application_action,
                                   lifecycle_status, submitted_at, created_by)
         values ('BP-2026-000002', $1, 'Fencing Permit', 'New', 'Approved', now(), $2)`,
        [APPLICANT, CITIZEN],
      ),
    ).rejects.toThrow(/may not be created at status/);
  });

  it('records every movement without being asked', async () => {
    await setStatus('Received');
    await setStatus('Document Verification');

    const trail = await db.query<{ from_status: string | null; to_status: string }>(
      'select from_status, to_status from application_transitions where application_id = $1 order by occurred_at',
      [APPLICATION],
    );

    expect(trail.rows).toEqual([
      { from_status: null, to_status: 'Submitted' },
      { from_status: 'Submitted', to_status: 'Received' },
      { from_status: 'Received', to_status: 'Document Verification' },
    ]);
  });

  it('bumps the version on every status change, for optimistic concurrency', async () => {
    await setStatus('Received');
    const result = await db.query<{ version: number }>('select version from applications where id = $1', [APPLICATION]);

    expect(result.rows[0]?.version).toBe(2);
  });

  it('refuses a draft with a filing date, and a filed application without one', async () => {
    await expect(
      db.query(
        `insert into applications (reference_number, applicant_id, permit_type, application_action,
                                   lifecycle_status, submitted_at, created_by)
         values ('BP-2026-000003', $1, 'Fencing Permit', 'New', 'Draft', now(), $2)`,
        [APPLICANT, CITIZEN],
      ),
    ).rejects.toThrow();
  });
});

describe('money', () => {
  const issueOrder = (overrides: Partial<Record<string, unknown>> = {}) => {
    const values = {
      filing: 50_000, processing: 120_000, architectural: 0,
      structural: 0, electrical: 0, others: 0, total: 170_000,
      ...overrides,
    };
    return db.query(
      `insert into orders_of_payment
         (id, application_id, number, filing_centavos, processing_centavos, architectural_centavos,
          structural_centavos, electrical_centavos, others_centavos, total_centavos,
          fee_schedule_version, assessed_by)
       values (gen_random_uuid(), $1, 'OP-2026-000001', $2, $3, $4, $5, $6, $7, $8, '2026.1', $9)`,
      [APPLICATION, values.filing, values.processing, values.architectural,
       values.structural, values.electrical, values.others, values.total, ASSESSOR],
    );
  };

  it('accepts an order whose total equals the sum of its lines', async () => {
    await advanceTo('Assessed');
    await expect(issueOrder()).resolves.toBeDefined();
  });

  it('REFUSES a total that does not equal its own lines', async () => {
    // Storing a total that can disagree with its components is how the figure
    // at the cashier stops matching the figure on the screen.
    await advanceTo('Assessed');
    await expect(issueOrder({ total: 999_999 })).rejects.toThrow(/total_equals_its_lines/);
  });

  it('REFUSES a negative fee line', async () => {
    await advanceTo('Assessed');
    await expect(issueOrder({ filing: -1, total: 119_999 })).rejects.toThrow();
  });

  it('REFUSES a non-integer amount', async () => {
    // This is the test that changed the schema. Written against BIGINT it
    // FAILED: PostgreSQL rounded 50000.75 to 50001 and accepted the row, so a
    // fee of PHP 500.0075 would have silently become PHP 500.01. NUMERIC with
    // scale(v) = 0 rejects it instead.
    await advanceTo('Assessed');
    await expect(
      db.query(
        `insert into orders_of_payment
           (application_id, number, filing_centavos, processing_centavos, architectural_centavos,
            structural_centavos, electrical_centavos, others_centavos, total_centavos,
            fee_schedule_version, assessed_by)
         values ($1, 'OP-X', 50000.75, 0, 0, 0, 0, 0, 50000.75, '2026.1', $2)`,
        [APPLICATION, ASSESSOR],
      ),
    ).rejects.toThrow();
  });

  it('REFUSES a payment with no Order of Payment', async () => {
    // Unrepresentable, not merely refused by the service: the foreign key is
    // NOT NULL. No assessment means no figure and no way to pay.
    await advanceTo('Assessed');
    await expect(
      db.query(
        `insert into payments (order_of_payment_id, application_id, reference_number,
                               amount_centavos, method, submitted_by)
         values (null, $1, 'REF-1', 170000, 'Bank Transfer', $2)`,
        [APPLICATION, CITIZEN],
      ),
    ).rejects.toThrow();
  });

  it('refuses a zero-value payment', async () => {
    await advanceTo('Assessed');
    await issueOrder();
    const order = await db.query<{ id: string }>('select id from orders_of_payment limit 1');

    await expect(
      db.query(
        `insert into payments (order_of_payment_id, application_id, reference_number,
                               amount_centavos, method, submitted_by)
         values ($1, $2, 'REF-1', 0, 'Bank Transfer', $3)`,
        [order.rows[0]?.id, APPLICATION, CITIZEN],
      ),
    ).rejects.toThrow();
  });

  it('refuses to mark a payment Paid without a verification and a receipt', async () => {
    await advanceTo('Assessed');
    await issueOrder();
    const order = await db.query<{ id: string }>('select id from orders_of_payment limit 1');

    await expect(
      db.query(
        `insert into payments (order_of_payment_id, application_id, reference_number,
                               amount_centavos, method, submitted_by, status)
         values ($1, $2, 'REF-1', 170000, 'Bank Transfer', $3, 'Paid')`,
        [order.rows[0]?.id, APPLICATION, CITIZEN],
      ),
    ).rejects.toThrow(/settled_requires_verification/);
  });

  it('refuses a REVERSED or REFUNDED payment with no verification either', async () => {
    // The constraint widened with TAB 07. A reversed payment WAS verified — the
    // verifier and receipt number are the evidence the money once appeared to
    // move — so arriving at that status without them is as impossible as
    // arriving at Paid without them.
    await issueOrder();
    const order = await db.query<{ id: string }>('select id from orders_of_payment limit 1');

    for (const status of ['Reversed', 'Refunded']) {
      await expect(
        db.query(
          `insert into payments (order_of_payment_id, application_id, reference_number,
                                 amount_centavos, method, submitted_by, status,
                                 exception_reason, exception_at, exception_by)
           values ($1, $2, 'REF-2', 170000, 'Bank Transfer', $3, $4, 'because', now(), $3)`,
          [order.rows[0]?.id, APPLICATION, CITIZEN, status],
        ),
      ).rejects.toThrow(/settled_requires_verification/);
    }
  });

  it('refuses to let the submitter of a payment also verify it', async () => {
    // Separation of duty, in the schema rather than in a policy document.
    await advanceTo('Assessed');
    await issueOrder();
    const order = await db.query<{ id: string }>('select id from orders_of_payment limit 1');

    await expect(
      db.query(
        `insert into payments (order_of_payment_id, application_id, reference_number,
                               amount_centavos, method, submitted_by, verified_by, verified_at,
                               official_receipt_number, status)
         values ($1, $2, 'REF-1', 170000, 'Onsite', $3, $3, now(), 'OR-1', 'Paid')`,
        [order.rows[0]?.id, APPLICATION, ASSESSOR],
      ),
    ).rejects.toThrow(/verifier_is_not_the_submitter/);
  });

  it('REFUSES to amend an issued Order of Payment', async () => {
    // Amending one after an applicant has been told what to pay is, from their
    // side, indistinguishable from being charged a different amount than quoted.
    await advanceTo('Assessed');
    await issueOrder();

    await expect(
      db.query('update orders_of_payment set filing_centavos = 1, total_centavos = 121000'),
    ).rejects.toThrow(/immutable/);
  });
});

describe('other things the database will not allow', () => {
  it('refuses an applicant holding a staff role', async () => {
    await expect(
      db.query('insert into account_roles (account_id, role) values ($1, $2)', [CITIZEN, 'building-official']),
    ).rejects.toThrow(/not staff/);
  });

  it('allows a staff account to hold a role', async () => {
    await expect(
      db.query('insert into account_roles (account_id, role) values ($1, $2)', [OFFICER, 'evaluator']),
    ).resolves.toBeDefined();
  });

  it('refuses two accounts differing only by the case of their email', async () => {
    await expect(
      db.query(
        `insert into accounts (kind, email, email_normalised, password_hash)
         values ('applicant', 'Maria@Example.PH', 'maria@example.ph', 'scrypt$1$1$1$a$b')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an adverse evaluation with no remarks', async () => {
    // An unexplained "Revision Required" is a deadline the applicant cannot
    // meet, because they do not know what to do.
    await expect(
      db.query(
        `insert into evaluations (application_id, stage, result, evaluator_id, evaluated_at)
         values ($1, 'Zoning', 'Revision Required', $2, now())`,
        [APPLICATION, OFFICER],
      ),
    ).rejects.toThrow(/adverse_result_has_remarks/);
  });

  it('refuses releasing a permit that was never generated', async () => {
    await advanceTo('Ready for Release');
    await expect(
      db.query(
        `insert into permit_releases (application_id, status, method, claimant_name,
                                      releasing_officer, released_at)
         values ($1, 'Released', 'Physical Claim', 'Maria Santos', $2, now())`,
        [APPLICATION, OFFICER],
      ),
    ).rejects.toThrow(/no generated permit/);
  });

  it('refuses a document marked Approved that nobody has scanned', async () => {
    await expect(
      db.query(
        `insert into documents (application_id, uploaded_by, label, file_name, content_type,
                                byte_size, sha256, storage_key, status, scan_cleared)
         values ($1, $2, 'TCT', 'tct.pdf', 'application/pdf', 100, $3, 'k/1', 'Approved', false)`,
        [APPLICATION, CITIZEN, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/approved_requires_scan/);
  });

  // ── The officer's verdict on one document ───────────────────────────────
  //
  // Owner decision 2026-08-28: a document is turned back on its own record,
  // with a standard reusable reason AND custom feedback. These prove the
  // database enforces the part that matters — an adverse verdict must say why.

  /** Files a document and returns its id. Scan-cleared, so it is reviewable. */
  async function fileDocument(key: string): Promise<string> {
    const inserted = await db.query<{ id: string }>(
      `insert into documents (application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared)
       values ($1, $2, 'TCT', 'tct.pdf', 'application/pdf', 100, $3, $4, 'Pending', true)
       returning id`,
      [APPLICATION, CITIZEN, 'b'.repeat(64), key],
    );
    return inserted.rows[0]!.id;
  }

  it('refuses a rejected document that says nothing about why', async () => {
    // The sibling of "refuses an adverse evaluation with no remarks". A
    // rejection with no reason leaves the applicant to guess, and guessing is
    // another trip to the office.
    const id = await fileDocument('k/review-1');
    await expect(
      db.query(
        `update documents set review_status = 'Rejected', reviewed_at = now() where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/adverse_review_has_reason/);
  });

  it('accepts a standard reason on its own', async () => {
    const id = await fileDocument('k/review-2');
    await db.query(
      `update documents set review_status = 'Revision Required',
                            review_reason_code = 'illegible', reviewed_at = now()
       where id = $1`,
      [id],
    );
    const row = await db.query<{ review_reason_code: string }>(
      `select review_reason_code from documents where id = $1`, [id],
    );
    expect(row.rows[0]!.review_reason_code).toBe('illegible');
  });

  it('accepts custom feedback on its own', async () => {
    const id = await fileDocument('k/review-3');
    await db.query(
      `update documents set review_status = 'Rejected',
                            review_remark = 'Page 3 is missing.', reviewed_at = now()
       where id = $1`,
      [id],
    );
    const row = await db.query<{ review_remark: string }>(
      `select review_remark from documents where id = $1`, [id],
    );
    expect(row.rows[0]!.review_remark).toBe('Page 3 is missing.');
  });

  it("refuses 'Other' with no custom feedback, because it means nothing alone", async () => {
    const id = await fileDocument('k/review-4');
    await expect(
      db.query(
        `update documents set review_status = 'Rejected',
                              review_reason_code = 'other', reviewed_at = now()
         where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/other_reason_needs_remark/);
  });

  it('refuses a verdict with no moment attached', async () => {
    const id = await fileDocument('k/review-5');
    await expect(
      db.query(
        `update documents set review_status = 'Accepted' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/reviewed_together/);
  });

  it('refuses an unknown review status', async () => {
    // The vocabulary is the portal's eight, verbatim. 'Approved' is the SCAN
    // column's word and must not leak into the officer's.
    const id = await fileDocument('k/review-6');
    await expect(
      db.query(
        `update documents set review_status = 'Approved', reviewed_at = now() where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/review_status/);
  });

  it('refuses two documents replacing the same one', async () => {
    // An ambiguity nothing downstream could resolve: which one did the office
    // actually receive?
    const original = await fileDocument('k/super-0');
    const first = await fileDocument('k/super-1');
    await db.query(
      `update documents set supersedes_document_id = $1 where id = $2`, [original, first],
    );
    const second = await fileDocument('k/super-2');
    await expect(
      db.query(
        `update documents set supersedes_document_id = $1 where id = $2`, [original, second],
      ),
    ).rejects.toThrow(/documents_supersedes_unique/);
  });

  it('refuses a document that replaces itself', async () => {
    const id = await fileDocument('k/super-self');
    await expect(
      db.query(
        `update documents set supersedes_document_id = $1 where id = $1`, [id],
      ),
    ).rejects.toThrow(/supersedes_not_self/);
  });

  it('keeps a retired reason resolvable on documents that cite it', async () => {
    // Retired rather than deleted: a reason cited last year must still render.
    const id = await fileDocument('k/retired');
    await db.query(
      `update documents set review_status = 'Rejected',
                            review_reason_code = 'expired', reviewed_at = now()
       where id = $1`, [id],
    );
    await expect(
      db.query(`delete from document_review_reasons where code = 'expired'`),
    ).rejects.toThrow();
  });

  it('refuses a checksum that is not a SHA-256', async () => {
    await expect(
      db.query(
        `insert into documents (application_id, uploaded_by, label, file_name, content_type,
                                byte_size, sha256, storage_key)
         values ($1, $2, 'TCT', 'tct.pdf', 'application/pdf', 100, 'not-a-hash', 'k/2')`,
        [APPLICATION, CITIZEN],
      ),
    ).rejects.toThrow();
  });

  it('refuses a holiday filed under the wrong year', async () => {
    await db.query('insert into holiday_calendars (year, complete) values (2026, false)');
    await expect(
      db.query(
        `insert into holidays (year, holiday_date, name, kind)
         values (2026, '2027-01-01', 'New Year', 'Regular Holiday')`,
      ),
    ).rejects.toThrow();
  });

  it('will not let an application be deleted out from under its history', async () => {
    await expect(db.query('delete from applications where id = $1', [APPLICATION])).rejects.toThrow();
  });
});

describe('the audit trail is append-only', () => {
  const write = () =>
    db.query(
      `insert into audit_events (actor_account_id, action, subject_type, subject_id, outcome, entry_hash)
       values ($1, 'application.viewed', 'application', $2, 'allowed', 'h1')`,
      [OFFICER, APPLICATION],
    );

  it('accepts a new entry', async () => {
    await expect(write()).resolves.toBeDefined();
  });

  it('REFUSES to update one', async () => {
    // An audit trail the application can edit proves nothing about the
    // application. Enforced in the database, so no credential -- including an
    // administrative one -- can rewrite history.
    await write();
    await expect(db.query("update audit_events set outcome = 'denied'")).rejects.toThrow(/append-only/);
  });

  it('REFUSES to delete one', async () => {
    await write();
    await expect(db.query('delete from audit_events')).rejects.toThrow(/append-only/);
  });
});
