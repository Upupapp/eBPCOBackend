import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { APPLICANT_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../../applications/domain/application';
import { EICAR, LocalSignatureScanner, UnavailableScanner } from '../domain/malware-scanner';
import { FilesystemObjectStore } from '../infrastructure/filesystem-object-store';
import { makeJpeg, makePdf, makePng } from '../domain/__fixtures__';
import { DocumentService, SecurityEvent } from './document.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

let db: SqlClient;
let root: string;
let store: FilesystemObjectStore;
let events: SecurityEvent[];

const OWNER_ACCOUNT = randomUUID();
const OTHER_ACCOUNT = randomUUID();
const OFFICER_ACCOUNT = randomUUID();
const APPLICATION = randomUUID();

const owner: Caller = { accountId: OWNER_ACCOUNT, kind: 'applicant', scopes: APPLICANT_SCOPES };
const stranger: Caller = { accountId: OTHER_ACCOUNT, kind: 'applicant', scopes: APPLICANT_SCOPES };
const officer: Caller = {
  accountId: OFFICER_ACCOUNT, kind: 'staff',
  scopes: [...new Set(Object.values(ROLE_SCOPES).flat())],
};

function service(options: { scannerDown?: boolean; now?: () => Date } = {}): DocumentService {
  return new DocumentService(
    db,
    store,
    options.scannerDown === true ? new UnavailableScanner() : new LocalSignatureScanner(),
    (event) => events.push(event),
    options.now ?? (() => new Date('2026-08-19T12:00:00Z')),
  );
}

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  root = await mkdtemp(join(tmpdir(), 'ebpco-store-'));
  store = new FilesystemObjectStore(root, 'a-test-signing-key', () => new Date('2026-08-19T12:00:00Z'));
  events = [];

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','owner@example.ph','owner@example.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','other@example.ph','other@example.ph','scrypt$1$1$1$a$b'),
            ($3,'staff','officer@lgu.gov.ph','officer@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [OWNER_ACCOUNT, OTHER_ACCOUNT, OFFICER_ACCOUNT],
  );
  const applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, OWNER_ACCOUNT],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000001',$2,'Fencing Permit','New','Submitted',now(),$3)`,
    [APPLICATION, applicantId, OWNER_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
  await rm(root, { recursive: true, force: true });
});

const upload = (bytes: Buffer, fileName: string, caller: Caller = owner, svc = service()) =>
  svc.upload({ bytes, fileName, label: 'Transfer Certificate of Title', applicationId: APPLICATION, caller });

describe('a clean upload', () => {
  it('is accepted, stored and cleared', async () => {
    const result = await upload(makePdf(), 'tct.pdf');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db.query<{ scan_cleared: boolean; content_type: string; sha256: string }>(
      'select scan_cleared, content_type, sha256 from documents where id = $1',
      [result.documentId],
    );
    expect(row.rows[0]?.scan_cleared).toBe(true);
    expect(row.rows[0]?.content_type).toBe('application/pdf');
    expect(row.rows[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records the content type the bytes say, not the name', async () => {
    const result = await upload(makeJpeg(), 'photo.jpg');
    if (!result.ok) return;

    const row = await db.query<{ content_type: string }>(
      'select content_type from documents where id = $1', [result.documentId],
    );
    expect(row.rows[0]?.content_type).toBe('image/jpeg');
  });

  it('stores the SCRUBBED bytes, so the GPS never reaches the LGU at all', async () => {
    // Not "stored then cleaned": what lands in the object store has never
    // contained the applicant's coordinates.
    const result = await upload(makeJpeg(), 'photo.jpg');
    if (!result.ok) return;

    const key = (await db.query<{ storage_key: string }>(
      'select storage_key from documents where id = $1', [result.documentId],
    )).rows[0]?.storage_key;

    const stored = await store.get(key!);
    expect(stored?.toString('latin1')).not.toContain('GPSLatitude');
    expect(result.removedMetadata).toContain('exif');
  });

  it('records a checksum of the bytes that were kept, not the ones sent', async () => {
    const result = await upload(makePng(), 'plan.png');
    if (!result.ok) return;

    // Read-back verifies the digest, so a mismatch here would fail.
    const read = await service().readContent(result.documentId);
    expect(read.ok).toBe(true);
  });

  it('gives every object an opaque, non-enumerable key', async () => {
    const first = await upload(makePdf(), 'a.pdf');
    const second = await upload(makePdf(), 'b.pdf');
    if (!first.ok || !second.ok) return;

    const keys = (await db.query<{ storage_key: string }>('select storage_key from documents')).rows
      .map((r) => r.storage_key);

    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).not.toContain('tct');
      expect(key).not.toContain(APPLICATION);
    }
  });
});

describe('an infected upload', () => {
  // Acceptance criterion: EICAR quarantined, never retrievable, raises a
  // security event.

  const eicarPdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from(EICAR, 'latin1')]);

  it('is rejected', async () => {
    const result = await upload(eicarPdf(), 'invoice.pdf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('infected');
  });

  it('is purged from the object store, not merely flagged', async () => {
    // There is no circumstance in which the LGU wants to keep a copy of
    // malware someone sent it.
    await upload(eicarPdf(), 'invoice.pdf');

    const key = (await db.query<{ storage_key: string }>('select storage_key from documents')).rows[0]?.storage_key;
    expect(await store.get(key!)).toBeNull();
  });

  it('is marked Rejected and never cleared', async () => {
    await upload(eicarPdf(), 'invoice.pdf');

    const row = await db.query<{ status: string; scan_cleared: boolean }>(
      'select status, scan_cleared from documents',
    );
    expect(row.rows[0]).toEqual({ status: 'Rejected', scan_cleared: false });
  });

  it('raises a security event naming the signature and the uploader', async () => {
    await upload(eicarPdf(), 'invoice.pdf');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'malware-detected', accountId: OWNER_ACCOUNT });
    expect(events[0]?.detail).toContain('EICAR');
  });

  it('is never retrievable afterwards', async () => {
    await upload(eicarPdf(), 'invoice.pdf');
    const documentId = (await db.query<{ id: string }>('select id from documents')).rows[0]?.id;

    const access = await service().contentUrl(documentId!, officer);
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.reason).toBe('quarantined');
  });

  it('catches an executable disguised inside an allowed format', async () => {
    const disguised = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from(EICAR, 'latin1'), makePdf()]);
    expect((await upload(disguised, 'x.pdf')).ok).toBe(false);
  });
});

describe('when the scanner is down', () => {
  it('keeps the upload rather than losing the applicant’s work', async () => {
    // The applicant did nothing wrong. Charging them for an LGU service outage
    // would be the system's failure billed to the citizen.
    const result = await upload(makePdf(), 'tct.pdf', owner, service({ scannerDown: true }));

    expect(result.ok).toBe(true);
  });

  it('leaves it unreadable by anyone, including an officer', async () => {
    const result = await upload(makePdf(), 'tct.pdf', owner, service({ scannerDown: true }));
    if (!result.ok) return;

    const access = await service().contentUrl(result.documentId, officer);
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.reason).toBe('not-scanned');
  });
});

describe('retrieval', () => {
  // Acceptance criteria: not downloadable between upload and scan completion;
  // a URL for another applicant's document is never issued.

  it('issues a short-lived URL to the owner', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    const access = await service().contentUrl(result.documentId, owner);
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.url).toContain('expires=');
  });

  it('issues a DIFFERENT URL each time, so none is a stable address', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    const first = await service().contentUrl(result.documentId, owner);
    const second = await service().contentUrl(result.documentId, owner);
    if (!first.ok || !second.ok) return;

    expect(first.url).not.toBe(second.url);
  });

  it('answers 404, not 403, for another applicant’s document', async () => {
    // A 403 confirms the document exists, and the disclosure is "this person
    // has an application with this LGU".
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    const access = await service().contentUrl(result.documentId, stranger);
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.reason).toBe('not-found');
  });

  it('raises a security event when one applicant reaches for another’s document', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    events.length = 0;

    await service().contentUrl(result.documentId, stranger);

    expect(events.map((e) => e.type)).toContain('unauthorised-document-access');
  });

  it('answers 404 for a document that does not exist, and for a malformed id', async () => {
    expect((await service().contentUrl(randomUUID(), owner)).ok).toBe(false);
    expect((await service().contentUrl('not-a-uuid', owner)).ok).toBe(false);
  });

  it('lets an officer read a document on an application that is not theirs', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    expect((await service().contentUrl(result.documentId, officer)).ok).toBe(true);
  });
});

describe('signed URLs expire', () => {
  it('accepts one inside its window and refuses it after', async () => {
    let now = new Date('2026-08-19T12:00:00Z');
    const expiring = new FilesystemObjectStore(root, 'a-test-signing-key', () => now);
    const url = await expiring.signedUrl('ab/cd/key', 120);
    const params = new URLSearchParams(url.split('?')[1]);

    const check = () =>
      expiring.verifySignedUrl(
        params.get('key')!, Number(params.get('expires')), params.get('n')!, params.get('sig')!,
      );

    expect(check()).toBe('ok');
    now = new Date('2026-08-19T12:03:00Z');
    expect(check()).toBe('expired');
  });

  it('refuses a tampered signature', async () => {
    const url = await store.signedUrl('ab/cd/key', 120);
    const params = new URLSearchParams(url.split('?')[1]);

    expect(
      store.verifySignedUrl(params.get('key')!, Number(params.get('expires')), params.get('n')!, 'forged'),
    ).toBe('invalid');
  });

  it('refuses a signature reused for a different object', async () => {
    const url = await store.signedUrl('ab/cd/mine', 120);
    const params = new URLSearchParams(url.split('?')[1]);

    expect(
      store.verifySignedUrl('ab/cd/yours', Number(params.get('expires')), params.get('n')!, params.get('sig')!),
    ).toBe('invalid');
  });

  it('refuses a key that tries to escape the store root', async () => {
    await expect(store.get('../../../etc/passwd')).resolves.toBeNull();
    await expect(store.put('../../escape', Buffer.from('x'), 'text/plain')).rejects.toThrow(/escapes/);
  });
});

describe('integrity', () => {
  // Acceptance criterion: a checksum mismatch fails closed and alerts. RA 8792
  // treats an electronic document as evidence, and evidence whose alteration
  // cannot be detected is not much use.

  it('returns the bytes when they match what was recorded', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    const read = await service().readContent(result.documentId);
    expect(read.ok).toBe(true);
  });

  it('fails closed when the stored object has been altered', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;

    const key = (await db.query<{ storage_key: string }>(
      'select storage_key from documents where id = $1', [result.documentId],
    )).rows[0]!.storage_key;
    await writeFile(join(root, key), Buffer.from('%PDF-1.4\nTAMPERED\n', 'latin1'));

    const read = await service().readContent(result.documentId);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('integrity');
    expect(events.map((e) => e.type)).toContain('checksum-mismatch');
  });

  it('does not serve the altered bytes with a warning', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    const key = (await db.query<{ storage_key: string }>(
      'select storage_key from documents where id = $1', [result.documentId],
    )).rows[0]!.storage_key;
    await writeFile(join(root, key), Buffer.from('%PDF-1.4\nTAMPERED\n', 'latin1'));

    const read = await service().readContent(result.documentId);
    expect(read).not.toHaveProperty('bytes');
  });
});

describe('retention', () => {
  // Acceptance criterion: deletes exactly the eligible objects, records each
  // deletion, and is idempotent.
  //
  // The clock now runs from when the APPLICATION CLOSED, not from when the file
  // was uploaded. These fixtures therefore have to close the application and
  // backdate the closing transition — which is more setup, and is the point:
  // the earlier version needed none of it because it would have deleted the
  // documents off an application still under evaluation.

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /** Moves the application to a terminal status and backdates the closure. */
  async function closed(days: number): Promise<void> {
    await db.query(`update applications set lifecycle_status = 'Received' where id = $1`, [APPLICATION]);
    await db.query(`update applications set lifecycle_status = 'Cancelled' where id = $1`, [APPLICATION]);
    await db.query(
      `update application_transitions set occurred_at = $1
        where application_id = $2 and to_status = 'Cancelled'`,
      [daysAgo(days), APPLICATION],
    );
  }

  it('deletes nothing when nothing is old enough', async () => {
    await upload(makePdf(), 'tct.pdf');
    await closed(1);

    expect(await service({ now: () => new Date() }).runRetention(3650))
      .toEqual({ deleted: 0, skippedOpen: 0 });
  });

  it('NEVER deletes a document on an application still in progress', async () => {
    // The defect this replaces. Measured from upload date, the plans on an
    // application still under evaluation vanish the moment they age past the
    // window — the applicant is asked to resubmit documents the LGU itself
    // threw away, and the evaluation record points at files that no longer
    // exist. There is no retention period for a matter still in progress.
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await db.query('update documents set uploaded_at = $1 where id = $2', [daysAgo(4000), result.documentId]);

    const outcome = await service({ now: () => new Date() }).runRetention(3650);

    expect(outcome.deleted).toBe(0);
    expect(outcome.skippedOpen).toBe(1);
  });

  it('says how many it held back, rather than reporting a bare zero', async () => {
    // "deleted 0" on a system full of old files reads like a broken job. An
    // operator needs to know documents were held back and why.
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await db.query('update documents set uploaded_at = $1 where id = $2', [daysAgo(4000), result.documentId]);

    expect((await service({ now: () => new Date() }).runRetention(3650)).skippedOpen).toBe(1);
  });

  it('deletes the object and marks the row', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await closed(4000);

    const key = (await db.query<{ storage_key: string }>(
      'select storage_key from documents where id = $1', [result.documentId],
    )).rows[0]!.storage_key;

    expect(await service({ now: () => new Date() }).runRetention(3650))
      .toEqual({ deleted: 1, skippedOpen: 0 });
    expect(await store.get(key)).toBeNull();

    const row = await db.query<{ deleted_at: Date | null }>(
      'select deleted_at from documents where id = $1', [result.documentId],
    );
    expect(row.rows[0]?.deleted_at).not.toBeNull();
  });

  it('records an audit event for every deletion', async () => {
    // "We deleted it as required" is a claim the LGU has to be able to
    // evidence.
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await closed(4000);

    await service({ now: () => new Date() }).runRetention(3650);

    const audit = await db.query<{ subject_id: string }>(
      "select subject_id from audit_events where action = 'document.deleted-on-retention'",
    );
    expect(audit.rows.map((r) => r.subject_id)).toEqual([result.documentId]);
  });

  it('is idempotent: a second run deletes nothing and writes no second event', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await closed(4000);

    const svc = service({ now: () => new Date() });
    await svc.runRetention(3650);
    expect(await svc.runRetention(3650)).toEqual({ deleted: 0, skippedOpen: 0 });

    const audit = await db.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'document.deleted-on-retention'",
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('leaves an application that closed recently alone', async () => {
    // "Inside the retention window" is now a property of the APPLICATION, not
    // of the file. Two applications, one closed long ago and one closed
    // yesterday, with a document each.
    const old = await upload(makePdf(), 'old.pdf');
    if (!old.ok) return;
    await closed(4000);

    const recentApplication = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                                 lifecycle_status, submitted_at, created_by)
       values ($1,'BP-2026-000099',(select applicant_id from applications where id = $2),
               'Fencing Permit','New','Submitted',now(),$3)`,
      [recentApplication, APPLICATION, OWNER_ACCOUNT],
    );
    const recentDocument = randomUUID();
    await db.query(
      `insert into documents (id, application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status)
       values ($1,$2,$3,'Plan','recent.pdf','application/pdf',1024,$4,'objects/recent.pdf','Pending')`,
      [recentDocument, recentApplication, OWNER_ACCOUNT, 'c'.repeat(64)],
    );
    await db.query(`update applications set lifecycle_status = 'Received' where id = $1`, [recentApplication]);
    await db.query(`update applications set lifecycle_status = 'Cancelled' where id = $1`, [recentApplication]);

    expect((await service({ now: () => new Date() }).runRetention(3650)).deleted).toBe(1);

    const survivor = await db.query<{ deleted_at: Date | null }>(
      'select deleted_at from documents where id = $1', [recentDocument],
    );
    expect(survivor.rows[0]?.deleted_at).toBeNull();
  });

  it('makes a deleted document unreachable', async () => {
    const result = await upload(makePdf(), 'tct.pdf');
    if (!result.ok) return;
    await closed(4000);
    await service({ now: () => new Date() }).runRetention(3650);

    expect((await service().contentUrl(result.documentId, owner)).ok).toBe(false);
  });
});

describe('the object store is not public', () => {
  // Acceptance criterion, checked per deploy. A public bucket of applicants'
  // identity documents is the worst single failure this system can have, and it
  // is a configuration mistake rather than a code one — so code cannot prevent
  // it, only detect it.
  it('reports whether it is readable without credentials', async () => {
    expect(await store.isPubliclyReadable()).toBe(false);
  });
});
