import { SqlClient } from '../../../persistence/sql-client';
import { lookup, remember, type Replay } from '../../../persistence/idempotency';
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

/**
 * What a resubmission can go wrong with, before any bytes are looked at.
 *
 * `not-found` covers three different facts on purpose -- no such document, not
 * on this application, or deleted -- because telling them apart would let a
 * citizen probe for document ids that are not theirs.
 */
export type ResubmitRefusal =
  | { readonly reason: 'not-found' }
  | { readonly reason: 'already-replaced'; readonly detail: string }
  | { readonly reason: 'accepted'; readonly detail: string };

/** Everything replacing a document can end as, on one axis. */
export type ResubmitOutcome =
  | { readonly kind: 'created'; readonly documentId: string; readonly status: DocumentStatus;
      readonly removedMetadata: readonly string[] }
  /** This exact request already happened. The stored answer, not a second document. */
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  /** Same key, different request -- a client bug, and answering it would answer for the wrong one. */
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'refused'; readonly refusal: ResubmitRefusal }
  | { readonly kind: 'unusable-file'; readonly detail: string; readonly infected: boolean };


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
  uploaded_by: string;
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
    /**
     * The document this one replaces (D-8), or null for a first submission.
     *
     * Carried into the INSERT rather than set by a follow-up update, so the
     * unique index on it is the authority: two resubmissions racing to replace
     * the same document cannot both win, and the loser fails before it can be
     * told it succeeded.
     */
    supersedes?: string | null;
    /** Which checklist entry this answers (C-6). Null means not attributed. */
    requirementCode?: string | null;
  }): Promise<UploadOutcome> {
    const { bytes, fileName, label, applicationId, caller } = options;
    const supersedes = options.supersedes ?? null;
    const requirementCode = options.requirementCode ?? null;

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
                              byte_size, sha256, storage_key, status, scan_cleared,
                              supersedes_document_id, requirement_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', false, $9, $10)
       returning id`,
      [applicationId, caller.accountId, label, fileName, inspection.inspection.format,
       scrubbed.bytes.length, digest, key, supersedes, requirementCode],
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
   * Replacing one document on an application with a newly supplied file (D-8).
   *
   * The office keeps every submission, so this APPENDS: the replacement is a
   * new row pointing at what it replaces, and the old document keeps its
   * rejection and the reason it was given. An applicant who resubmits a
   * rejected land title does not lose the record of what was wrong, and the
   * officer can see what changed. Migration 027 modelled it this way; this is
   * the route that finally writes it.
   *
   * The file goes through `upload` rather than a second path of its own. Magic-
   * byte inspection, metadata scrubbing, the malware scan and the object store
   * are the risky parts, and a second implementation of them is a second place
   * for them to be wrong.
   */
  async resubmit(options: {
    applicationId: string;
    supersededDocumentId: string;
    bytes: Buffer;
    fileName: string;
    label: string;
    caller: Caller;
    /** Do-this-once. Required, as it is on every other applicant write. */
    idempotencyKey: string;
    /** Fingerprint of the request, so the same key with a changed body is caught. */
    digest: string;
  }): Promise<ResubmitOutcome> {
    const { applicationId, supersededDocumentId, caller } = options;

    // Before the preconditions, because a replay must answer what it answered
    // the first time even if the document has since been replaced -- otherwise
    // a retry after a dropped connection reports a conflict for its own success.
    const seen = await lookup<Replay<unknown>['body']>(this.db, {
      accountId: caller.accountId, key: options.idempotencyKey,
      operation: 'document.resubmit', digest: options.digest,
    });
    if (seen.kind === 'replay') {
      return { kind: 'replay', status: seen.previous.status, body: seen.previous.body };
    }
    if (seen.kind === 'mismatch') return { kind: 'mismatch' };

    const existing = await this.db.query<{
      review_status: string | null; replaced_by: string | null; requirement_code: string | null;
    }>(
      `select d.review_status, d.requirement_code,
              (select r.id from documents r
                where r.supersedes_document_id = d.id and r.deleted_at is null) as replaced_by
         from documents d
        where d.id = $1 and d.application_id = $2 and d.deleted_at is null`,
      [supersededDocumentId, applicationId],
    );

    const row = existing.rows[0];
    if (row === undefined) return { kind: 'refused', refusal: { reason: 'not-found' } };

    if (row.replaced_by !== null) {
      // The unique index would refuse this anyway, but only after the bytes
      // were stored and scanned. Refusing here means a citizen who taps twice
      // does not pay for an upload that was never going to land.
      return { kind: 'refused', refusal: { reason: 'already-replaced',
        detail: 'This document has already been replaced. Read the application again to see the current one.' } };
    }

    if (row.review_status === 'Accepted') {
      // An officer has approved this one. Replacing it would silently undo
      // that approval, and the applicant would not be told they had done so.
      // Reversible from the office's side -- an officer can mark it Expired or
      // Revision Required -- which is where that decision belongs.
      return { kind: 'refused', refusal: { reason: 'accepted',
        detail: 'This document has already been accepted. The office must ask for a replacement before one can be sent.' } };
    }

    const uploaded = await this.upload({
      bytes: options.bytes,
      fileName: options.fileName,
      label: options.label,
      applicationId,
      caller,
      supersedes: supersededDocumentId,
      // INHERITED, not re-declared (C-6). A replacement answers the same
      // checklist entry the rejected document answered -- the applicant is
      // responding to a verdict, not choosing a requirement afresh -- and
      // taking it from the client would let a resubmission silently reattribute
      // itself, or lose the attribution entirely and read as "not provided"
      // the moment it was fixed.
      requirementCode: row.requirement_code,
    });

    if (!uploaded.ok) {
      // Not remembered. A key recorded for a failure would replay that failure
      // to a client retrying with a file that is now fine.
      return { kind: 'unusable-file', detail: uploaded.failure.detail,
        infected: uploaded.failure.reason === 'infected' };
    }

    const body = {
      documentId: uploaded.documentId,
      supersedesDocumentId: supersededDocumentId,
      status: uploaded.status,
      removedMetadata: uploaded.removedMetadata,
    };
    // Recorded AFTER the document exists, not inside its transaction -- the
    // upload spans an object-store write and a malware scan, and holding a
    // database transaction across those would be worse than the gap it closes.
    // The gap is a crash between the two, which leaves a document with no key;
    // the retry then finds it already replaced and is refused rather than
    // duplicating it. Safe, and honest about which of the two it is.
    await remember(this.db, {
      accountId: caller.accountId, key: options.idempotencyKey,
      operation: 'document.resubmit', digest: options.digest,
      status: 201, body,
    });

    return { kind: 'created', documentId: uploaded.documentId, status: uploaded.status,
      removedMetadata: uploaded.removedMetadata };
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
    if (caller.kind === 'applicant' && !ownedBy(document, caller.accountId)) {
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
  /**
   * Deletes documents whose application closed longer ago than the LGU keeps
   * them.
   *
   * Measured from **when the application closed**, not from when the file was
   * uploaded. The version this replaces used upload date, which deletes the
   * plans off an application still under evaluation the moment they age past
   * the window — the applicant is asked to resubmit documents the LGU itself
   * threw away, and the evaluation record points at files that no longer exist.
   *
   * An application that has not reached a terminal status is never touched,
   * however old its documents are. There is no retention period for a matter
   * still in progress.
   *
   * `retainForDays` is the LGU's number (M-15) and this service does not have
   * a default for it: a retention period invented here would be a
   * data-minimisation decision made by the wrong party.
   */
  async runRetention(retainForDays: number): Promise<{ deleted: number; skippedOpen: number }> {
    const cutoff = new Date(this.clock().getTime() - retainForDays * 24 * 60 * 60 * 1000);

    // The closing transition is the event that starts the clock. Reading it
    // from application_transitions rather than from updated_at, because
    // updated_at moves for reasons that have nothing to do with closure.
    const eligible = await this.db.query<{ id: string; storage_key: string }>(
      `select d.id, d.storage_key
         from documents d
         join applications a on a.id = d.application_id
         join lifecycle_statuses ls on ls.status = a.lifecycle_status
        where d.deleted_at is null
          and ls.terminal
          and (
            select max(t.occurred_at) from application_transitions t
             where t.application_id = a.id and t.to_status = a.lifecycle_status
          ) < $1`,
      [cutoff],
    );

    // Counted and reported rather than silently excluded. An operator running
    // retention needs to know that documents were held back, and why — "deleted
    // 0" on a system full of old files reads like a broken job.
    const open = await this.db.query<{ n: string }>(
      `select count(*) as n
         from documents d
         join applications a on a.id = d.application_id
         join lifecycle_statuses ls on ls.status = a.lifecycle_status
        where d.deleted_at is null and not ls.terminal and d.uploaded_at < $1`,
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

    return { deleted: eligible.rows.length, skippedOpen: Number(open.rows[0]?.n ?? 0) };
  }

  /**
   * Serves the bytes behind a signed URL.
   *
   * The signature IS the authorisation here — that is what a signed URL is for,
   * and why the route redeeming it is public. So everything else the caller
   * would normally be checked for has to have been checked when the URL was
   * MINTED, in `contentUrl`, and the window between the two is why the URL
   * expires in two minutes.
   *
   * The scan and quarantine checks are repeated anyway. A document can be
   * rejected by a rescan in the seconds after a link was issued, and a link
   * that keeps working after the file was quarantined is the one case where
   * these two minutes matter.
   */
  async redeem(key: string, expiresAt: number, nonce: string, signature: string): Promise<
    | { readonly ok: true; readonly bytes: Buffer; readonly fileName: string; readonly contentType: string }
    | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'not-found' | 'integrity' }
  > {
    const verdict = this.store.verifySignedUrl(key, expiresAt, nonce, signature);
    if (verdict !== 'ok') return { ok: false, reason: verdict };

    const document = await this.loadByStorageKey(key);
    // A forged-but-valid signature over an unknown key answers the same as a
    // bad signature would.
    if (document === null) return { ok: false, reason: 'not-found' };
    if (document.status === 'Rejected' || !document.scan_cleared) {
      return { ok: false, reason: 'not-found' };
    }

    const content = await this.readContent(document.id);
    if (!content.ok) return { ok: false, reason: content.reason };

    return {
      ok: true,
      bytes: content.bytes,
      fileName: document.file_name,
      contentType: document.content_type,
    };
  }

  private async loadByStorageKey(key: string): Promise<(DocumentRow & { file_name: string; content_type: string }) | null> {
    const result = await this.db.query<DocumentRow & { file_name: string; content_type: string }>(
      `select d.id, d.application_id, d.storage_key, d.sha256, d.status, d.scan_cleared,
              d.uploaded_by, d.file_name, d.content_type, acc.id as applicant_account_id
         from documents d
         left join applications a on a.id = d.application_id
         left join applicants ap on ap.id = a.applicant_id
         left join accounts acc on acc.id = ap.account_id
        where d.storage_key = $1 and d.deleted_at is null`,
      [key],
    );
    return result.rows[0] ?? null;
  }

  private async load(documentId: string): Promise<DocumentRow | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(documentId)) return null;
    const result = await this.db.query<DocumentRow>(
      `select d.id, d.application_id, d.storage_key, d.sha256, d.status, d.scan_cleared,
              d.uploaded_by, acc.id as applicant_account_id
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

/**
 * Whether an applicant may read this document.
 *
 * Two ways, and only checking the second was a real defect: the mobile wizard
 * uploads documents BEFORE the application exists — that is the whole flow, and
 * why `POST /documents` accepts a null application id — so a document has no
 * application to be owned through until the moment it is filed. Reading
 * ownership solely from the application meant an applicant could not open,
 * check or re-read anything they had just uploaded.
 *
 * Attaching is already restricted to documents you uploaded and that are not
 * yet attached, so `uploaded_by` cannot be used to reach into someone else's
 * application later.
 */
function ownedBy(document: { uploaded_by: string; applicant_account_id: string | null }, accountId: string): boolean {
  return document.uploaded_by === accountId || document.applicant_account_id === accountId;
}
