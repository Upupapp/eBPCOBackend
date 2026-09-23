import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
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
  permitType: 'Fencing Permit',
  applicationAction: 'New',
  businessId: null,
  location: '12 Rizal Street, Poblacion Uno',
  documentIds: [],
  form: {},
  ...overrides,
});

async function uploadedDocument(uploader: string, requirementCode: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                            byte_size, sha256, storage_key, status, requirement_code)
     values ($1,null,$2,'Lot plan','plan.pdf','application/pdf',1024,$3,$4,'Pending',$5)`,
    [id, uploader, 'a'.repeat(64), `objects/${id}.pdf`, requirementCode],
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
      caller: maria, submission: submission({ permitType: 'Demolition Permit' }), idempotencyKey: key,
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

describe('a permit that predates eBPCO', () => {
  // Migration 053's own reason for existing: eBPCO launched into a
  // Municipality with decades of paper permits already outstanding, so
  // `renewsPermitNumber` (which must resolve to a real generated_permits row)
  // is a dead end for most real renewals. `priorPermitClaim` is the
  // unverified alternative — accepted only alongside the proof document
  // requirement code 053 seeded for every permit type.

  it('refuses a claimed prior permit with no proof attached', async () => {
    const result = await submissions.submit({
      caller: maria,
      submission: submission({ applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('prior-permit-proof-required');
  });

  it('leaves nothing behind when a prior-permit claim has no proof', async () => {
    // The same guarantee the ordinary refusal path already has — see "leaves
    // nothing behind when a submission is refused" above. Checked separately
    // because this refusal was deliberately moved to run BEFORE the
    // application row is inserted (see resolveRenewal()'s own doc comment):
    // this proves that placement actually holds, not just that the reason
    // code is right.
    await submissions.submit({
      caller: maria,
      submission: submission({ applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' }),
      idempotencyKey: randomUUID(),
    });

    expect(await count('select count(*) as n from applications')).toBe(0);
    expect(await count(`select count(*) as n from document_number_sequences where series = 'APP'`)).toBe(0);
  });

  it('accepts a claimed prior permit once proof is attached', async () => {
    const proof = await uploadedDocument(MARIA, 'prior-permit-proof');

    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042', documentIds: [proof],
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.query<{ prior_permit_claim: string | null; renews_permit_id: string | null }>(
      'select prior_permit_claim, renews_permit_id from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]?.prior_permit_claim).toBe('BP-1998-000042');
    expect(row.rows[0]?.renews_permit_id).toBeNull();
  });

  it('refuses naming both a permit on file and a prior-permit claim', async () => {
    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'Renewal', renewsPermitNumber: 'BP-2026-000001', priorPermitClaim: 'BP-1998-000042',
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('renewal-reference-conflict');
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
       values ($1,'Fencing Permit','Simple',7,'2026-01-01','2027-01-01','2026.1','Charter 2026'),
              ($2,'Fencing Permit','Complex',20,'2027-01-01',null,'2027.1','Charter 2027')`,
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

/**
 * `form` used to reach the controller, be parsed, and be dropped. An applicant
 * filled in fifteen screens of a wizard, and an officer opening the application
 * saw a permit type, a location and a stack of documents — none of what they
 * had actually typed.
 */
describe('the applicant’s own answers', () => {
  it('survive the filing', async () => {
    const answers = { lotArea: 240, storeys: 2, engineer: 'Ana Dela Cruz, PRC 0012345' };

    const result = await submissions.submit({
      caller: maria, submission: submission({ form: answers }), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ form: Record<string, unknown> }>(
      'select form from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.form).toEqual(answers);
  });

  it('defaults to an empty object rather than null', async () => {
    // A null form is a third state a reader has to handle. There is no such
    // thing as an application with no answers — only one with none yet.
    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ form: unknown }>(
      'select form from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.form).toEqual({});
  });

  it('records that nothing checked it, rather than leaving that to be assumed', async () => {
    // `where form_validated_against is null` is every application filed before
    // there was a schema to check against — the question somebody will need
    // answered when the LGU's forms arrive, and one that cannot be
    // reconstructed afterwards.
    const result = await submissions.submit({
      caller: maria, submission: submission({ form: { anything: true } }), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const row = await db.query<{ form_validated_against: string | null }>(
      'select form_validated_against from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]!.form_validated_against).toBeNull();
  });

  it('makes a replay with DIFFERENT answers a different request', async () => {
    // The form is part of the request's identity. Without it, a replay carrying
    // corrected answers under the same key would be treated as the same
    // submission and the corrections silently discarded.
    const key = randomUUID();
    await submissions.submit({
      caller: maria, submission: submission({ form: { storeys: 1 } }), idempotencyKey: key,
    });

    const corrected = await submissions.submit({
      caller: maria, submission: submission({ form: { storeys: 2 } }), idempotencyKey: key,
    });

    expect(corrected.ok).toBe(false);
    if (corrected.ok) return;
    expect(corrected.reason).toBe('key-reused');
  });

  it('replays identical answers as the same request', async () => {
    const key = randomUUID();
    const form = { storeys: 2, lotArea: 240 };
    const first = await submissions.submit({
      caller: maria, submission: submission({ form }), idempotencyKey: key,
    });
    const replay = await submissions.submit({
      caller: maria, submission: submission({ form }), idempotencyKey: key,
    });

    expect(replay.ok && replay.replayed).toBe(true);
    expect(first.ok && replay.ok && replay.applicationId).toBe(first.ok ? first.applicationId : '');
  });
});

describe('saving a draft', () => {
  it('files at Draft, with a real reference number and no submitted_at yet', async () => {
    const result = await submissions.submit({
      caller: maria, submission: submission({ saveAsDraft: true }), idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.referenceNumber).toMatch(/^E-BPCO-2026-\d{6}$/);
    const row = await db.query<{ lifecycle_status: string; submitted_at: Date | null; created_by: string }>(
      'select lifecycle_status, submitted_at, created_by from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]).toEqual({ lifecycle_status: 'Draft', submitted_at: null, created_by: MARIA });
  });

  it('tolerates a Renewal naming neither a permit on file nor a prior-permit claim yet', async () => {
    // A real (non-draft) filing refuses this as renewal-needs-a-permit -- the
    // whole point of a draft is that the citizen has picked Renewal and
    // stopped there.
    const result = await submissions.submit({
      caller: maria,
      submission: submission({ applicationAction: 'Renewal', saveAsDraft: true }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
  });

  it('still refuses a New application naming a permit reference, even as a draft', async () => {
    // Not every refusal in resolveRenewal() is about a gap still to be
    // filled in -- naming a permit on a New application is a genuine error
    // in what was given.
    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'New', renewsPermitNumber: 'BP-2026-000001', saveAsDraft: true,
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-a-renewal');
  });

  it('still refuses naming both a permit on file and a prior-permit claim, even as a draft', async () => {
    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'Renewal', renewsPermitNumber: 'BP-2026-000001',
        priorPermitClaim: 'BP-1998-000042', saveAsDraft: true,
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('renewal-reference-conflict');
  });

  it('still refuses an unknown permit type as a draft', async () => {
    // A bad answer, not an unfinished one -- draft status relaxes gaps, not
    // errors.
    const result = await submissions.submit({
      caller: maria, submission: submission({ permitType: 'Time Machine', saveAsDraft: true }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-permit-type');
  });

  it('tolerates a claimed prior permit with no proof attached yet', async () => {
    // The other check saveAsDraft relaxes: a real filing refuses this as
    // prior-permit-proof-required (see "a permit that predates eBPCO" above).
    const result = await submissions.submit({
      caller: maria,
      submission: submission({
        applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042', saveAsDraft: true,
      }),
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.query<{ prior_permit_claim: string | null }>(
      'select prior_permit_claim from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]?.prior_permit_claim).toBe('BP-1998-000042');
  });

  it('records a draft-saved audit action, not a submitted one', async () => {
    const result = await submissions.submit({
      caller: maria, submission: submission({ saveAsDraft: true }), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const audit = await db.query<{ action: string }>(
      'select action from audit_events where subject_id = $1', [result.applicationId],
    );
    expect(audit.rows[0]?.action).toBe('application.draft-saved');
  });
});

describe('filing for a walk-in, as a draft', () => {
  // fileOnBehalf() itself has no other unit coverage in this file — these
  // two are scoped to the one thing this session added, saveAsDraft, not a
  // general backfill of the walk-in path.

  async function officer(): Promise<Caller> {
    const accountId = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
      [accountId, `officer-${accountId.slice(0, 8)}@lgu.gov.ph`],
    );
    return { accountId, kind: 'staff', scopes: ROLE_SCOPES['records-officer'] };
  }

  it('files a walk-in at Draft, crediting the officer as created_by and the citizen as applicant', async () => {
    const caller = await officer();
    const result = await submissions.fileOnBehalf({
      caller,
      applicant: { firstName: 'Pedro', lastName: 'Reyes', email: 'pedro@example.ph', mobileNumber: null },
      business: {
        name: 'Reyes Sari-Sari', category: 'Retail', street: '1 Main', barangay: 'Poblacion',
        city: 'Castilla', province: 'Sorsogon', registrationNumber: 'DTI-9', dateRegistered: '2024-01-01',
      },
      businessId: null,
      submission: { permitType: 'Fencing Permit', applicationAction: 'New', location: null, form: {} },
      saveAsDraft: true,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.query<{ lifecycle_status: string; submitted_at: Date | null; created_by: string }>(
      'select lifecycle_status, submitted_at, created_by from applications where id = $1', [result.applicationId],
    );
    expect(row.rows[0]).toEqual({ lifecycle_status: 'Draft', submitted_at: null, created_by: caller.accountId });
  });

  it('tolerates a Renewal naming no reference yet, the same relaxation the self-service path gets', async () => {
    const caller = await officer();
    const result = await submissions.fileOnBehalf({
      caller,
      applicant: { firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.ph', mobileNumber: null },
      business: {
        name: 'Cruz Hardware', category: 'Retail', street: '2 Main', barangay: 'Poblacion',
        city: 'Castilla', province: 'Sorsogon', registrationNumber: 'DTI-10', dateRegistered: '2024-01-01',
      },
      businessId: null,
      submission: { permitType: 'Fencing Permit', applicationAction: 'Renewal', location: null, form: {} },
      saveAsDraft: true,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
  });
});

describe('updateDraft', () => {
  async function draftId(overrides: Partial<Submission> = {}): Promise<string> {
    const result = await submissions.submit({
      caller: maria, submission: submission({ saveAsDraft: true, ...overrides }), idempotencyKey: randomUUID(),
    });
    if (!result.ok) throw new Error('setup: expected the draft to be created');
    return result.applicationId;
  }

  it('refuses an application that does not exist', async () => {
    const result = await submissions.updateDraft({
      caller: maria, applicationId: randomUUID(), patch: { location: 'New address' },
    });

    expect(result).toEqual({ ok: false, reason: 'not-found', detail: expect.any(String) });
  });

  it('refuses a draft that belongs to a different applicant', async () => {
    const id = await draftId();
    const jose: Caller = { accountId: JOSE, kind: 'applicant', scopes: APPLICANT_SCOPES };

    const result = await submissions.updateDraft({
      caller: jose, applicationId: id, patch: { location: 'Somewhere else' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });

  it('refuses editing an application that has already been filed', async () => {
    const result = await submissions.submit({
      caller: maria, submission: submission(), idempotencyKey: randomUUID(),
    });
    if (!result.ok) return;

    const updated = await submissions.updateDraft({
      caller: maria, applicationId: result.applicationId, patch: { location: 'New address' },
    });

    expect(updated).toEqual({ ok: false, reason: 'not-a-draft', detail: expect.any(String) });
  });

  it('updates the fields given, and bumps updated_at/updated_by', async () => {
    const id = await draftId();

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: { location: 'New address, Barangay Uno' },
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ location: string; updated_by: string }>(
      'select location, updated_by from applications where id = $1', [id],
    );
    expect(row.rows[0]).toEqual({ location: 'New address, Barangay Uno', updated_by: MARIA });
  });

  it('refuses an unknown permit type', async () => {
    const id = await draftId();

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: { permitType: 'Time Machine' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-permit-type');
  });

  it('refuses a business not registered to this applicant', async () => {
    const id = await draftId();
    const business = randomUUID();
    await db.query(
      `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                               province, registration_number, date_registered)
       values ($1,$2,'Jose Hardware','Retail','1 Main','Poblacion','Cabuyao','Laguna','DTI-1','2024-01-15')`,
      [business, joseApplicant],
    );

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: { businessId: business },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('business-not-yours');
  });

  it('re-resolves the renewal reference when applicationAction is patched', async () => {
    const id = await draftId({ applicationAction: 'New' });

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id,
      patch: { applicationAction: 'Renewal', priorPermitClaim: 'BP-1998-000042' },
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ application_action: string; prior_permit_claim: string | null }>(
      'select application_action, prior_permit_claim from applications where id = $1', [id],
    );
    expect(row.rows[0]).toEqual({ application_action: 'Renewal', prior_permit_claim: 'BP-1998-000042' });
  });

  it('refuses a bad renewal reference the same way a fresh filing would', async () => {
    const id = await draftId({ applicationAction: 'New' });

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id,
      patch: { applicationAction: 'Renewal', renewsPermitNumber: 'BP-9999-000001' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('permit-not-found');
  });

  it('re-snapshots required_documents when applicationAction changes', async () => {
    // Migration 053 seeded prior-permit-proof onto Renewal/Amendment's
    // checklist but not New's, for every permit type -- an observable,
    // real difference to prove the resnapshot actually happened, not a
    // fabricated one.
    const id = await draftId({ applicationAction: 'New' });
    const before = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [id],
    );
    expect(before.rows[0]?.required_documents.some((d) => d.code === 'prior-permit-proof')).toBe(false);

    await submissions.updateDraft({
      caller: maria, applicationId: id, patch: { applicationAction: 'Renewal' },
    });

    const after = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [id],
    );
    expect(after.rows[0]?.required_documents.some((d) => d.code === 'prior-permit-proof')).toBe(true);
  });

  it('attaches new documents the same ownership-checked way submit() does', async () => {
    const id = await draftId();
    const document = await uploadedDocument(MARIA);

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: {}, documentIds: [document],
    });

    expect(result.ok).toBe(true);
    expect(await count(
      'select count(*) as n from documents where application_id = $1', [id],
    )).toBe(1);
  });

  it('refuses someone else\'s document', async () => {
    const id = await draftId();
    const josesDocument = await uploadedDocument(JOSE);

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: {}, documentIds: [josesDocument],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('documents-not-yours');
  });

  it('refuses a document whose requirement code is not on this draft\'s checklist', async () => {
    const id = await draftId();
    const document = await uploadedDocument(MARIA, 'not-a-real-requirement');

    const result = await submissions.updateDraft({
      caller: maria, applicationId: id, patch: {}, documentIds: [document],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('requirement-unknown');
  });
});
