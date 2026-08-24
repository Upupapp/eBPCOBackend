import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ObjectStore } from '../../documents/domain/object-store';
import { DataExportService, EXPORT_SECTIONS, EXPORT_TTL_HOURS, assertNoSecrets } from './data-export.service';

/**
 * A portable copy of one person's data, under RA 10173 §18.
 *
 * The tests that matter are the exclusions. Anyone can serialise a database;
 * the difficult part is being sure the file does not contain a credential or
 * somebody else's record — and being able to prove it rather than believe it.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
let NOW = new Date('2026-08-24T02:00:00Z');

let db: SqlClient;
let store: FakeStore;
let dataExports: DataExportService;

const MARIA = randomUUID();
const JOSE = randomUUID();
let mariaApplicant: string;
let mariaApplication: string;

class FakeStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];

  put = (key: string, bytes: Buffer): Promise<void> => {
    this.objects.set(key, bytes);
    return Promise.resolve();
  };

  get = (key: string): Promise<Buffer | null> => Promise.resolve(this.objects.get(key) ?? null);

  delete = (key: string): Promise<boolean> => {
    this.deleted.push(key);
    return Promise.resolve(this.objects.delete(key));
  };

  signedUrl = (key: string, expiresInSeconds: number): Promise<string> =>
    Promise.resolve(`https://objects.test/${key}?expires=${expiresInSeconds}`);

  isPubliclyReadable = (): Promise<boolean> => Promise.resolve(false);
}

/** The produced file, parsed. */
async function produced(requestId: string): Promise<Record<string, unknown>> {
  const row = await db.query<{ storage_key: string }>(
    'select storage_key from data_export_requests where id = $1', [requestId],
  );
  const bytes = store.objects.get(row.rows[0]!.storage_key);
  if (bytes === undefined) throw new Error('no object was written');
  return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  NOW = new Date('2026-08-24T02:00:00Z');
  store = new FakeStore();
  dataExports = new DataExportService(db, store, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number, totp_secret_encrypted)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$verifier','09171234567','totp-secret'),
            ($2,'applicant','jose@example.ph','jose@example.ph','scrypt$1$1$1$b',null,null)`,
    [MARIA, JOSE],
  );
  mariaApplicant = randomUUID();
  const joseApplicant = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name)
     values ($1,$2,'Maria','Santos'), ($3,$4,'Jose','Rizal')`,
    [mariaApplicant, MARIA, joseApplicant, JOSE],
  );
  mariaApplication = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               location, lifecycle_status, submitted_at, created_by)
     values ($1,'E-BPCO-2026-000041',$2,'Fencing','New','12 Rizal Street','Submitted',$3,$4)`,
    [mariaApplication, mariaApplicant, NOW, MARIA],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'E-BPCO-2026-000042',$2,'Fencing','New','Submitted',$3,$4)`,
    [randomUUID(), joseApplicant, NOW, JOSE],
  );
  await db.query(
    `insert into devices (id, account_id, platform, push_token_digest, push_token_encrypted)
     values ($1,$2,'android','the-token-digest','the-token-itself')`,
    [randomUUID(), MARIA],
  );
});

afterEach(async () => {
  await db.close();
});

describe('what the file must not contain', () => {
  it('carries no password verifier, TOTP secret or push token', async () => {
    // These are credentials rather than records. Releasing them is not access —
    // it is handing whoever ends up with the file the means to act as the
    // subject.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const text = JSON.stringify(await produced(requestId));
    expect(text).not.toContain('scrypt$1$1$1$verifier');
    expect(text).not.toContain('totp-secret');
    expect(text).not.toContain('the-token-digest');
    expect(text).not.toContain('the-token-itself');
  });

  it('refuses to produce a file at all if a credential field appears', () => {
    // A silent strip would let an export ship with a secret removed by luck.
    // This fails, so the file does not exist.
    expect(() => assertNoSecrets({ account: { password_hash: 'anything' } }))
      .toThrow(/credential fields/);
    expect(() => assertNoSecrets({ device: { pushTokenEncrypted: 'anything' } }))
      .toThrow(/credential fields/);
  });

  it('is driven by the register, so a new secret column is covered the day it is added', () => {
    // Not a hand-written list of field names that someone has to remember to
    // update. `assertNoSecrets` reads the register.
    expect(() => assertNoSecrets({ x: { totp_secret_encrypted: 'v' } })).toThrow();
    expect(() => assertNoSecrets({ x: { secret_digest: 'v' } })).toThrow();
  });

  it('carries no other applicant’s data', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const text = JSON.stringify(await produced(requestId));
    expect(text).toContain('E-BPCO-2026-000041');
    expect(text).not.toContain('E-BPCO-2026-000042');
    // Jose's email and his surname as a NAME. Not the bare string "Rizal",
    // which appears legitimately in Maria's own street address — the first
    // version of this test asserted that and failed on her data rather than
    // his.
    expect(text).not.toContain('jose@example.ph');
    expect(text).not.toMatch(/"last_name"\s*:\s*"Rizal"/);
  });

  it('carries the history as events, never as raw before/after state', async () => {
    // The audit blobs "may contain any personal data from the row they
    // describe", which can include an officer's id or, on a superseded Order of
    // Payment, another person's details. A portability right is a right to your
    // own data, not a window on everyone who touched it.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const document = await produced(requestId);
    const text = JSON.stringify(document);
    expect(document).toHaveProperty('history');
    expect(text).not.toContain('before_state');
    expect(text).not.toContain('after_state');
    expect(text).not.toContain('entry_hash');
  });

  it('says plainly what was left out and why', async () => {
    // A person receiving an incomplete file is entitled to know it is
    // incomplete, and on what basis.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const about = (await produced(requestId))._about as { notIncluded: string[] };
    expect(about.notIncluded.join(' ')).toMatch(/credentials rather than records/);
  });
});

describe('what the file contains', () => {
  it('carries the account, the profile and the applications', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const document = await produced(requestId);
    expect((document.account as { email: string }).email).toBe('maria@example.ph');
    expect((document.applicantProfile as { first_name: string }).first_name).toBe('Maria');
    expect(document.applications).toHaveLength(1);
  });

  it('carries device metadata without the token', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const devices = (await produced(requestId)).devices as { platform: string }[];
    expect(devices).toHaveLength(1);
    expect(devices[0]!.platform).toBe('android');
  });

  it('says how to read it, because a portable copy nobody can interpret is not portable', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const about = (await produced(requestId))._about as { format: string };
    expect(about.format).toMatch(/centavos/);
  });

  it('records a checksum so the subject can verify what they downloaded', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const status = await dataExports.statusOf(MARIA, requestId);
    expect(status?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('completeness', () => {
  it('carries the applicant’s own answers', async () => {
    // The most obviously theirs thing in the record — fifteen screens they
    // typed. Omitting it from a portability copy while including the LGU's
    // notes about them would be an odd reading of whose data this is.
    await db.query(
      `update applications set form = $2 where id = $1`,
      [mariaApplication, JSON.stringify({ lotArea: 240, engineer: 'Ana Dela Cruz, PRC 0012345' })],
    );
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const applications = (await produced(requestId)).applications as { form: Record<string, unknown> }[];
    expect(applications[0]!.form).toEqual({ lotArea: 240, engineer: 'Ana Dela Cruz, PRC 0012345' });
  });

  it('does not carry whether the LGU had a schema to check it against', () => {
    // An operational fact about the LGU rather than personal data, classified
    // `none` in the register — and absent from the applicant's own view of an
    // application for the same reason.
    expect(EXPORT_SECTIONS).not.toContain('formValidatedAgainst');
  });

  it('carries every section it claims to', async () => {
    // Named rather than implied, so removing one is a failing test rather than
    // a quiet omission. A copy that silently lost a section is
    // indistinguishable, to the person receiving it, from one where the LGU
    // held nothing.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    expect(Object.keys(await produced(requestId)).sort()).toEqual([...EXPORT_SECTIONS].sort());
  });
});

describe('requesting', () => {
  it('returns the outstanding request rather than queueing a second', async () => {
    // A person pressing the button twice is not making a second request, and an
    // error would read as the LGU declining to answer a statutory right.
    const first = await dataExports.request(MARIA);
    const second = await dataExports.request(MARIA);

    expect(second.requestId).toBe(first.requestId);
    const rows = await db.query<{ n: string }>('select count(*) as n from data_export_requests');
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('allows a new request once the first has finished', async () => {
    const first = await dataExports.request(MARIA);
    await dataExports.produce(first.requestId);

    const second = await dataExports.request(MARIA);

    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe('reading someone else’s request', () => {
  it('answers the same as one that does not exist', async () => {
    const { requestId } = await dataExports.request(MARIA);

    expect(await dataExports.statusOf(JOSE, requestId)).toBeNull();
    expect(await dataExports.downloadUrl(JOSE, requestId)).toBeNull();
  });

  it('refuses an id that is not a UUID, without touching the database', async () => {
    expect(await dataExports.statusOf(MARIA, "1' or '1'='1")).toBeNull();
  });
});

describe('the download link', () => {
  it('is not issued before the file exists', async () => {
    const { requestId } = await dataExports.request(MARIA);

    expect(await dataExports.downloadUrl(MARIA, requestId)).toBeNull();
  });

  it('is issued once it does', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    expect(await dataExports.downloadUrl(MARIA, requestId)).toContain('https://objects.test/');
  });

  it('stops working the moment the request expires, not when a job next runs', async () => {
    // The sweeper runs daily. A link must stop working when it is due to, not
    // up to a day later.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    NOW = new Date(NOW.getTime() + (EXPORT_TTL_HOURS + 1) * 3_600_000);

    expect(await dataExports.downloadUrl(MARIA, requestId)).toBeNull();
  });

  it('never outlives the request, however long the signing window would allow', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);
    NOW = new Date(NOW.getTime() + (EXPORT_TTL_HOURS - 0.1) * 3_600_000);

    const url = await dataExports.downloadUrl(MARIA, requestId);

    const expires = Number(/expires=(\d+)/.exec(url ?? '')?.[1] ?? 0);
    expect(expires).toBeLessThanOrEqual(Math.ceil(0.1 * 3600) + 1);
  });
});

describe('expiry', () => {
  it('deletes the file and forgets where it was', async () => {
    // A row that still names an object which no longer exists invites a later
    // reader to try to fetch it.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);
    const key = (await db.query<{ storage_key: string }>(
      'select storage_key from data_export_requests where id = $1', [requestId],
    )).rows[0]!.storage_key;

    NOW = new Date(NOW.getTime() + (EXPORT_TTL_HOURS + 1) * 3_600_000);
    const swept = await dataExports.sweepExpired();

    expect(swept.expired).toBe(1);
    expect(store.deleted).toContain(key);
    const row = await db.query<{ status: string; storage_key: string | null }>(
      'select status, storage_key from data_export_requests where id = $1', [requestId],
    );
    expect(row.rows[0]!.status).toBe('expired');
    expect(row.rows[0]!.storage_key).toBeNull();
  });

  it('leaves a file still inside its window alone', async () => {
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    expect((await dataExports.sweepExpired()).expired).toBe(0);
  });
});

describe('when producing fails', () => {
  it('records why, rather than leaving the request queued for ever', async () => {
    // An export that quietly produced nothing is indistinguishable, from the
    // applicant's side, from one the LGU ignored.
    const failing = new DataExportService(
      db,
      { ...store, put: () => Promise.reject(new Error('object store unreachable')) },
      () => NOW,
    );
    const { requestId } = await failing.request(MARIA);

    const outcome = await failing.produce(requestId);

    expect(outcome.ok).toBe(false);
    const row = await db.query<{ status: string; failure_detail: string | null }>(
      'select status, failure_detail from data_export_requests where id = $1', [requestId],
    );
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.failure_detail).toContain('object store unreachable');
  });

  it('truncates the reason rather than storing whatever the query touched', async () => {
    const failing = new DataExportService(
      db,
      { ...store, put: () => Promise.reject(new Error('x'.repeat(5000))) },
      () => NOW,
    );
    const { requestId } = await failing.request(MARIA);
    await failing.produce(requestId);

    const row = await db.query<{ failure_detail: string }>(
      'select failure_detail from data_export_requests where id = $1', [requestId],
    );
    expect(row.rows[0]!.failure_detail.length).toBeLessThanOrEqual(200);
  });
});

describe('the audit trail', () => {
  it('records that the LGU answered', async () => {
    // The evidence that a statutory right was honoured, within the fifteen days
    // RA 10173 allows.
    const { requestId } = await dataExports.request(MARIA);
    await dataExports.produce(requestId);

    const audit = await db.query<{ n: string }>(
      `select count(*) as n from audit_events where action = 'account.data-exported' and subject_id = $1`,
      [requestId],
    );
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });
});
