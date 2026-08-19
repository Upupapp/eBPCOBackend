import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';
import { inspect, InspectionFailure } from '../domain/content-inspection';
import { MalwareScanner, ScanResult } from '../domain/malware-scanner';
import { ObjectStore, newObjectKey, sha256 } from '../domain/object-store';
import { scrub } from '../domain/metadata-scrubber';

/**
 * Everything that happens to a file between an applicant sending it and an
 * officer being able to open it.
 *
 * The order is not arbitrary. Inspect before storing, so a file that is not
 * what it claims never reaches the store. Scrub before hashing, so the recorded
 * checksum is of the bytes actually kept. Store before scanning, so a scanner
 * outage does not lose the applicant's upload. Mark clear only after a clean
 * verdict, so nothing is ever readable that has not been checked.
 */

export interface SecurityEvent {
  readonly type: 'malware-detected' | 'checksum-mismatch' | 'unauthorised-document-access';
  readonly detail: string;
  readonly documentId?: string;
  readonly accountId?: string;
}

export type UploadOutcome =
  | { readonly ok: true; readonly documentId: string; readonly status: DocumentStatus; readonly removedMetadata: readonly string[] }
  | { readonly ok: false; readonly failure: InspectionFailure }
  | { readonly ok: false; readonly failure: { reason: 'infected'; detail: string } };

export type DocumentStatus = 'Pending' | 'Approved' | 'Rejected' | 'Missing';

export type ContentAccess =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-scanned' | 'quarantined' };

interface DocumentRow {
  id: string;
  application_id: string | null;
  storage_key: string;
  sha256: string;
  status: DocumentStatus;
  scan_cleared: boolean;
  applicant_account_id: string | null;
}

export const SIGNED_URL_TTL_SECONDS = 120;

export class DocumentService {
  constructor(
    private readonly db: SqlClient,
    private readonly store: ObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly onSecurityEvent: (event: SecurityEvent) => void = () => undefined,
    private readonly clock: () => Date = () => new Date(),
    private readonly audit: AuditService = new AuditService(db, clock),
  ) {}

  async upload(options: {
    bytes: Buffer;
    fileName: string;
    label: string;
    applicationId: string | null;
    caller: Caller;
  }): Promise<UploadOutcome> {
    const { bytes, fileName, label, applicationId, caller } = options;

    const inspection = inspect(bytes, fileName);
    if (!inspection.ok) return { ok: false, failure: inspection.failure };

    // Before hashing and before storing: the checksum must describe what is
    // kept, and what is kept must not carry the applicant's GPS coordinates.
    const scrubbed = scrub(bytes, inspection.inspection.format);
    const digest = sha256(scrubbed.bytes);
    const key = newObjectKey();

    await this.store.put(key, scrubbed.bytes, inspection.inspection.format);

    const inserted = await this.db.query<{ id: string }>(
      `insert into documents (application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', false)
       returning id`,
      [applicationId, caller.accountId, label, fileName, inspection.inspection.format,
       scrubbed.bytes.length, digest, key],
    );
    const documentId = inserted.rows[0]?.id ?? '';

    const verdict = await this.scanner.scan(scrubbed.bytes);
    const status = await this.applyVerdict(documentId, key, verdict, caller);

    if (status === 'Rejected') {
      return {
        ok: false,
        failure: {
          reason: 'infected',
          detail: 'This file was rejected because it failed a malware check. Upload a different copy.',
        },
      };
    }

    return { ok: true, documentId, status, removedMetadata: scrubbed.removed };
  }

  /**
   * Records the scan outcome.
   *
   * `unavailable` deliberately leaves the document Pending and uncleared rather
   * than rejecting it. The applicant did nothing wrong, and losing their upload
   * because an LGU service is down would charge the system's failure to them.
   * The file stays stored, unreadable by anyone, and is re-queued.
   */
  private async applyVerdict(
    documentId: string,
    key: string,
    result: ScanResult,
    caller: Caller,
  ): Promise<DocumentStatus> {
    if (result.verdict === 'infected') {
      // The bytes go immediately. There is no circumstance in which the LGU
      // wants to keep a copy of malware someone sent it.
      await this.store.delete(key);
      await this.db.query(
        `update documents set status = 'Rejected', scan_cleared = false, scanned_at = $1 where id = $2`,
        [result.scannedAt, documentId],
      );
      this.onSecurityEvent({
        type: 'malware-detected',
        documentId,
        accountId: caller.accountId,
        detail: `Upload rejected and purged. Signature: ${result.signature ?? 'unknown'}.`,
      });
      return 'Rejected';
    }

    if (result.verdict === 'unavailable') {
      await this.db.query('update documents set scan_cleared = false where id = $1', [documentId]);
      return 'Pending';
    }

    await this.db.query(
      `update documents set scan_cleared = true, scanned_at = $1 where id = $2`,
      [result.scannedAt, documentId],
    );
    return 'Pending';
  }

  /**
   * Issues a short-lived URL, but only to someone entitled to the parent
   * application and only for a document that has cleared scanning.
   */
  async contentUrl(documentId: string, caller: Caller): Promise<ContentAccess> {
    const document = await this.load(documentId);

    // 404, not 403, for another applicant's document. A 403 confirms it exists,
    // which is itself a disclosure — and the disclosure is "this person has an
    // application with this LGU".
    if (document === null) return { ok: false, reason: 'not-found' };
    if (caller.kind === 'applicant' && document.applicant_account_id !== caller.accountId) {
      this.onSecurityEvent({
        type: 'unauthorised-document-access',
        documentId,
        accountId: caller.accountId,
        detail: 'An applicant requested a document belonging to another applicant.',
      });
      return { ok: false, reason: 'not-found' };
    }

    if (document.status === 'Rejected') return { ok: false, reason: 'quarantined' };
    // The window between upload and a clean verdict: nobody may read it, not
    // even the officer who would open it.
    if (!document.scan_cleared) return { ok: false, reason: 'not-scanned' };

    return { ok: true, url: await this.store.signedUrl(document.storage_key, SIGNED_URL_TTL_SECONDS) };
  }

  /**
   * Fetches bytes and verifies they are the bytes that were stored.
   *
   * A mismatch means the object was altered after upload, which is the exact
   * thing RA 8792's treatment of electronic documents as evidence requires to
   * be detectable. It fails closed and alerts rather than serving the file with
   * a warning.
   */
  async readContent(documentId: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: 'not-found' | 'integrity' }> {
    const document = await this.load(documentId);
    if (document === null || !document.scan_cleared) return { ok: false, reason: 'not-found' };

    const bytes = await this.store.get(document.storage_key);
    if (bytes === null) return { ok: false, reason: 'not-found' };

    if (sha256(bytes) !== document.sha256) {
      this.onSecurityEvent({
        type: 'checksum-mismatch',
        documentId,
        detail: 'Stored bytes do not match the checksum recorded at upload. The object may have been altered.',
      });
      return { ok: false, reason: 'integrity' };
    }

    return { ok: true, bytes };
  }

  /**
   * Deletes documents past their retention period.
   *
   * Idempotent by construction: it selects only rows with no `deleted_at`, so a
   * second run finds nothing. Every deletion writes an audit event, because
   * "we deleted it as required" is a claim the LGU has to be able to evidence.
   */
  async runRetention(retainForDays: number): Promise<{ deleted: number }> {
    const cutoff = new Date(this.clock().getTime() - retainForDays * 24 * 60 * 60 * 1000);

    const eligible = await this.db.query<{ id: string; storage_key: string }>(
      `select id, storage_key from documents
        where deleted_at is null and uploaded_at < $1`,
      [cutoff],
    );

    for (const document of eligible.rows) {
      await this.store.delete(document.storage_key);
      await this.db.query('update documents set deleted_at = $1 where id = $2', [this.clock(), document.id]);
      // "We deleted it as required" is a claim the LGU has to be able to
      // evidence, so the deletion is itself a chained audit entry.
      await this.audit.append({
        action: 'document.deleted-on-retention',
        subjectType: 'document',
        subjectId: document.id,
        outcome: 'allowed',
      });
    }

    return { deleted: eligible.rows.length };
  }

  private async load(documentId: string): Promise<DocumentRow | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(documentId)) return null;
    const result = await this.db.query<DocumentRow>(
      `select d.id, d.application_id, d.storage_key, d.sha256, d.status, d.scan_cleared,
              acc.id as applicant_account_id
         from documents d
         left join applications a on a.id = d.application_id
         left join applicants ap on ap.id = a.applicant_id
         left join accounts acc on acc.id = ap.account_id
        where d.id = $1 and d.deleted_at is null`,
      [documentId],
    );
    return result.rows[0] ?? null;
  }
}
