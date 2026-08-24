import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES } from '../../identity/domain/account';
import { Caller } from '../domain/application';
import { Submission, SubmissionService } from './submission.service';

/**
 * Filing an application, exactly once.
 *
 * The replay tests are the ones that matter. The mobile client queues
 * submissions offline and replays them, and the case this has to survive is a
 * submission the server committed whose response was lost — without the key
 * that is a second building permit for the same fence.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T06:00:00Z');

let db: SqlClient;
let submissions: SubmissionService;

const MARIA = randomUUID();
const JOSE = randomUUID();
let mariaApplicant: string;
let joseApplicant: string;

const maria: Caller = { accountId: MARIA, kind: 'applicant', scopes: APPLICANT_SCOPES };

const submission = (overrides: Partial<Submission> = {}): Submission => ({
  permitType: 'Fencing',
  applicationAction: 'New',
  businessId: null,
  location: '12 Rizal Street, Poblacion Uno',
  documentIds: [],
  ...overrides,
});

async function uploadedDocument(uploader: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                            byte_size, sha256, storage_key, status)
     values ($1,null,$2,'Lot plan','plan.pdf','application/pdf',1024,$3,$4,'Pending')`,
    [id, uploader, 'a'.repeat(64), `objects/${id}.pdf`],
  );
  return id;
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  submissions = new SubmissionService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','jose@example.ph','jose@example.ph','scrypt$1$1$1$a$b')`,
    [MARIA, JOSE],
  );
  mariaApplicant = randomUUID();
  joseApplicant = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name)
     values ($1,$2,'Maria','Santos'), ($3,$4,'Jose','Rizal')`,
    [mariaApplicant, MARIA, joseApplicant, JOSE],
  );
});

afterEach(async () => {
  await db.close();
});

const count = async (sql: string, values: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);

describe('filing', () => {
  it('files one application and gives back a reference to quote', async () => {
    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.referenceNumber).toMatch(/^E-BPCO-2026-\d{6}$/);
  });

  it('files it as Submitted, whatever the client would like', async () => {
    // A client that could name its own status could file an application
    // already Approved.
    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ lifecycle_status: string; created_by: string }>(
      'select lifecycle_status, created_by from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.lifecycle_status).toBe('Submitted');
    expect(row.rows[0]!.created_by).toBe(MARIA);
  });

  it('never issues the same reference twice', async () => {
    // Two applications sharing a reference is two filings the LGU cannot tell
    // apart at a counter.
    const references = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await submissions.submit({
        caller: maria, submission: submission(), idempotencyKey: randomUUID(),
      });
      if (result.ok) references.push(result.referenceNumber);
    }

    expect(new Set(references).size).toBe(5);
  });
});

describe('replay, which is what the offline queue does', () => {
  it('returns the original application rather than filing a second', async () => {
    // The case: the server committed and the response was lost. Without the
    // key this is a second building permit for the same fence.
    const key = randomUUID();
    const first = await submissions.submit({ caller: maria, submission: submission(), idempotencyKey: key });
    const replay = await submissions.submit({ caller: maria, submission: submission(), idempotencyKey: key });

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.applicationId).toBe(first.applicationId);
    expect(replay.replayed).toBe(true);
    expect(await count('select count(*) as n from applications')).toBe(1);
  });

  it('holds however many times it is replayed', async () => {
    const key = randomUUID();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submissions.submit({ caller: maria, submission: submission(), idempotencyKey: key });
    }

    expect(await count('select count(*) as n from applications')).toBe(1);
  });

  it('does not treat a reordered document list as a different request', async () => {
    // The client's queue may serialise the same submission with its documents
    // in a different order. Treating that as a new request would file twice.
    const a = await uploadedDocument(MARIA);
    const b = await uploadedDocument(MARIA);
    const key = randomUUID();

    await submissions.submit({
      caller: maria, submission: submission({ documentIds: [a, b] }), idempotencyKey: key,
    });
    const replay = await submissions.submit({
      caller: maria, submission: submission({ documentIds: [b, a] }), idempotencyKey: key,
    });

    expect(replay.ok && replay.replayed).toBe(true);
    expect(await count('select count(*) as n from applications')).toBe(1);
  });

  it('refuses the same key for a genuinely different application', async () => {
    // Honouring it would tell the applicant their Fencing permit was filed when
    // what they actually sent was a Demolition.
    const key = randomUUID();
    await submissions.submit({ caller: maria, submission: submission(), idempotencyKey: key });

    const different = await submissions.submit({
      caller: maria, submission: submission({ permitType: 'Demolition' }), idempotencyKey: key,
    });

    expect(different.ok).toBe(false);
    if (different.ok) return;
    expect(different.reason).toBe('key-reused');
  });

  it('scopes the key to the account, so two applicants cannot collide', async () => {
    const key = randomUUID();
    const jose: Caller = { accountId: JOSE, kind: 'applicant', scopes: APPLICANT_SCOPES };

    await submissions.submit({ caller: maria, submission: submission(), idempotencyKey: key });
    const second = await submissions.submit({ caller: jose, submission: submission(), idempotencyKey: key });

    expect(second.ok && second.replayed).toBe(false);
    expect(await count('select count(*) as n from applications')).toBe(2);
  });
});

describe('what an applicant may attach', () => {
  it('attaches their own uploaded documents', async () => {
    const document = await uploadedDocument(MARIA);

    const result = await submissions.submit({
      caller: maria, submission: submission({ documentIds: [document] }), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await count(
      'select count(*) as n from documents where application_id = $1', [result.applicationId],
    )).toBe(1);
  });

  it('refuses someone else’s document', async () => {
    const josesDocument = await uploadedDocument(JOSE);

    const result = await submissions.submit({
      caller: maria, submission: submission({ documentIds: [josesDocument] }), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('documents-not-yours');
  });

  it('refuses a document already attached to another application', async () => {
    // Without this a document could be pointed at a new filing and disappear
    // from the one an officer is evaluating.
    const document = await uploadedDocument(MARIA);
    await submissions.submit({
      caller: maria, submission: submission({ documentIds: [document] }), idempotencyKey: randomUUID(),
    });

    const second = await submissions.submit({
      caller: maria, submission: submission({ documentIds: [document] }), idempotencyKey: randomUUID(),
    });

    expect(second.ok).toBe(false);
  });

  it('refuses a business registered to someone else', async () => {
    // Filing against it would put their registered name and address on the
    // application.
    const business = randomUUID();
    await db.query(
      `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                               province, registration_number, date_registered)
       values ($1,$2,'Jose Hardware','Retail','1 Main','Poblacion','Cabuyao','Laguna','DTI-1','2024-01-15')`,
      [business, joseApplicant],
    );

    const result = await submissions.submit({
      caller: maria, submission: submission({ businessId: business }), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('business-not-yours');
  });
});

describe('refusals', () => {
  it('refuses a permit type the LGU does not issue', async () => {
    const result = await submissions.submit({
      caller: maria, submission: submission({ permitType: 'Time Machine' }), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('Time Machine');
  });

  it('refuses an account with no applicant profile, rather than inventing one', async () => {
    // An applicant record carries a name that belongs on a permit, and guessing
    // one from an email address puts that guess on a legal document.
    const orphan = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'applicant','orphan@example.ph','orphan@example.ph','scrypt$1$1$1$a$b')`, [orphan],
    );

    const result = await submissions.submit({
      caller: { accountId: orphan, kind: 'applicant', scopes: APPLICANT_SCOPES },
      submission: submission(), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-applicant-record');
  });

  it('leaves nothing behind when a submission is refused', async () => {
    // The reference counter, the audit entry and the idempotency key are all
    // inside the transaction. A refused filing that consumed a reference number
    // leaves a gap nobody can explain.
    await submissions.submit({
      caller: maria, submission: submission({ permitType: 'Time Machine' }), idempotencyKey: randomUUID(),
    });

    expect(await count('select count(*) as n from applications')).toBe(0);
    expect(await count('select count(*) as n from audit_events')).toBe(0);
    expect(await count('select count(*) as n from idempotency_keys')).toBe(0);
    expect(await count(`select count(*) as n from document_number_sequences where series = 'APP'`)).toBe(0);
  });
});

describe('the pledge an applicant is given', () => {
  it('is the charter entry in force on the filing date, not the latest one', async () => {
    // An application is judged against the pledge published when it was filed.
    // Re-reading the current entry later would move a deadline the applicant
    // was already given.
    const older = randomUUID();
    const newer = randomUUID();
    await db.query(
      `insert into charter_entries (id, permit_type, classification, pledged_working_days,
                                    effective_from, effective_to, fee_schedule_version, legal_basis)
       values ($1,'Fencing','Simple',7,'2026-01-01','2027-01-01','2026.1','Charter 2026'),
              ($2,'Fencing','Complex',20,'2027-01-01',null,'2027.1','Charter 2027')`,
      [older, newer],
    );

    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ charter_entry_id: string; classification: string }>(
      'select charter_entry_id, classification from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.charter_entry_id).toBe(older);
    expect(row.rows[0]!.classification).toBe('Simple');
  });

  it('files without one where the charter has no entry', async () => {
    // No countdown at all, rather than a guessed deadline. The clients say
    // "Awaiting classification".
    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ charter_entry_id: string | null; classification: string | null }>(
      'select charter_entry_id, classification from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.charter_entry_id).toBeNull();
    expect(row.rows[0]!.classification).toBeNull();
  });
});
