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
  | { readonly ok: false; readonly failure: { reason: 'infected'; detail: string } }
  | { readonly ok: false; readonly failure: { reason: 'duplicate'; detail: string; existing: ExistingCopy } };

/** The copy of a file a citizen already has, named so a client can offer it for reuse instead. */
export interface ExistingCopy {
  readonly id: string;
  readonly fileName: string;
  readonly label: string;
  /** The application it is attached to, or null when it sits unattached in My Documents. */
  readonly applicationReference: string | null;
}

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
    /** Provenance as printed on the document (migration 051). All optional; see the upload route's shape. */
    issuingOffice?: string | null;
    issuedOn?: string | null;
    expiresOn?: string | null;
    /** Which checklist entry this answers (C-6). Null means not attributed. */
    requirementCode?: string | null;
    /**
     * The citizen's own document this upload is a copy of: a document reused
     * from My Documents on another application. A document belongs to one
     * application, so reusing one is uploading its bytes again; saying so is
     * what lets the same file through the duplicate check below.
     */
    reuseOf?: string | null;
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

    // The same file again (owner request, 2026-09-29). A citizen who already
    // has it in My Documents is told to reuse it, rather than filling the
    // library with copies. Checked before anything is stored. Not for staff
    // (a walk-in intake uploads on the citizen's behalf, with no library of
    // its own) nor for a resubmission (replacing a returned document is its
    // own decision, made on the application).
    if (caller.kind === 'applicant' && supersedes === null) {
      const existing = await this.copyOf(caller.accountId, digest);
      if (existing !== null && !(await this.isReuseOf(options.reuseOf ?? null, caller.accountId, digest))) {
        return {
          ok: false,
          failure: {
            reason: 'duplicate',
            detail: `You already uploaded this file ("${existing.fileName}"). Reuse it from My Documents instead of `
              + 'uploading it again.',
            existing,
          },
        };
      }
    }

    const key = newObjectKey();

    await this.store.put(key, scrubbed.bytes, inspection.inspection.format);

    const inserted = await this.db.query<{ id: string }>(
      `insert into documents (application_id, uploaded_by, label, file_name, content_type,
                              byte_size, sha256, storage_key, status, scan_cleared,
                              supersedes_document_id, requirement_code,
                              issuing_office, issued_on, expires_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', false, $9, $10, $11, $12, $13)
       returning id`,
      [applicationId, caller.accountId, label, fileName, inspection.inspection.format,
       scrubbed.bytes.length, digest, key, supersedes, requirementCode,
       options.issuingOffice ?? null, options.issuedOn ?? null, options.expiresOn ?? null],
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

    // An applicant adding a document to an application already filed (a
    // missing one, asked for when it was returned) -- the Records Officer
    // should hear about it. A replacement is announced by `resubmit`.
    if (caller.kind === 'applicant' && applicationId !== null && supersedes === null) {
      await this.tellRecordsOfficers(applicationId, label, 'added');
    }

    return { ok: true, documentId, status, removedMetadata: scrubbed.removed };
  }

  /**
   * A staff officer's verdict on whether one document satisfies its
   * requirement — writes the columns migration 027 already added
   * (`review_status`, `review_reason_code`, `review_remark`, `reviewed_by`,
   * `reviewed_at`). Separate from the malware scanner's `status`: a
   * document can be scan-cleared ('Approved') and still be the wrong
   * document, or the right one with an illegible signature — migration
   * 027's own comment explains at length why this is not a widening of
   * that column. `review_status` shares its 8-value vocabulary with the
   * portal's own `DocumentStatus`; this method only accepts the four an
   * officer can actually choose from the Documents tab.
   *
   * Refuses a document that is not scan-cleared — an officer cannot have
   * actually looked at bytes nobody may retrieve yet — and refuses an
   * adverse verdict with neither a reason code nor a remark, the same rule
   * `adverse_review_has_reason` enforces; checked here too so the caller
   * gets a clear refusal instead of a raw constraint-violation error.
   */
  async review(options: {
    applicationId: string;
    documentId: string;
    status: 'Under Review' | 'Accepted' | 'Rejected' | 'Revision Required';
    reasonCode?: string | null;
    remark?: string | null;
    caller: Caller;
  }): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'not-found' | 'not-scan-cleared' | 'reason-required' }
  > {
    const { applicationId, documentId, status, caller } = options;
    const reasonCode = options.reasonCode?.trim() || null;
    const remark = options.remark?.trim() || null;
    const isAdverse = status === 'Rejected' || status === 'Revision Required';
    if (isAdverse && !reasonCode && !remark) {
      return { ok: false, reason: 'reason-required' };
    }
    if (reasonCode === 'other' && !remark) {
      return { ok: false, reason: 'reason-required' };
    }

    const found = await this.db.query<{ scan_cleared: boolean }>(
      `select scan_cleared from documents
        where id = $1 and application_id = $2 and deleted_at is null`,
      [documentId, applicationId],
    );
    const row = found.rows[0];
    if (row === undefined) return { ok: false, reason: 'not-found' };
    if (!row.scan_cleared) return { ok: false, reason: 'not-scan-cleared' };

    const now = this.clock();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `update documents
            set review_status = $1, review_reason_code = $2, review_remark = $3,
                reviewed_by = $4, reviewed_at = $5
          where id = $6`,
        [status, reasonCode, remark, caller.accountId, now, documentId],
      );
      // A document sent back told the applicant nothing -- found live: the
      // citizen only learned of it by happening to open the application.
      // Written in the same transaction as the verdict, so a notice never
      // describes a verdict that rolled back.
      if (isAdverse) {
        await this.tellApplicantDocumentReturned(tx, applicationId, documentId, status, remark);
      }
    });
    await this.audit.append({
      action: 'document.reviewed',
      subjectType: 'document',
      subjectId: documentId,
      outcome: 'allowed',
      actorAccountId: caller.accountId,
      actorRole: caller.kind,
      afterState: { status, reasonCode, remark },
    });
    return { ok: true };
  }

  /**
   * Every document this account has ever uploaded, attached or not.
   *
   * Keyed on `uploaded_by`, the only ownership a document has independent of
   * an application. Originally this returned only UNATTACHED documents
   * (`application_id is null`) — the narrowest possible reading of "mine" —
   * but that made a document reusable exactly once: the moment it was
   * attached to an application, it fell out of this list and out of reach for
   * a second one, even though the citizen plainly still owns it and a second
   * permit may legitimately need the same tax clearance or valid ID. Every
   * document is now returned, each carrying which application (if any) it is
   * currently attached to — a citizen's full history, and the reuse source
   * for a new filing, in one list.
   */
  async historyFor(accountId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    // One entry per FILE, not per copy (owner request, 2026-09-29). Reusing a
    // document on another application uploads a copy of it (a document
    // belongs to one application), and every copy used to be its own card in
    // My Documents: the same valid ID five times over. Copies are grouped by
    // fingerprint; the entry shown is the unattached copy when there is one
    // (free to attach as it is), otherwise the newest, and `applications`
    // names every application a copy is on. The copies themselves are
    // untouched: each application keeps its own, with its own review.
    const result = await this.db.query<{
      id: string; label: string; file_name: string; content_type: string;
      byte_size: string; uploaded_at: Date; requirement_code: string | null;
      expires_on: string | null; certified_on: string | null;
      scan_cleared: boolean; quarantined: boolean;
      application_id: string | null; application_reference: string | null;
      review_status: string | null;
      applications: { id: string; referenceNumber: string | null }[] | null;
      copies: string;
    }>(
      `with library as (
       select d.id, d.label, d.file_name, d.content_type, d.byte_size::text as byte_size, d.sha256,
              d.uploaded_at, d.requirement_code, d.scan_cleared,
              -- The document's OWN validity, which is the thing that matters
              -- most here and was missing. This list is what a citizen reuses a
              -- document from, and without it a client can only show when the
              -- file was uploaded -- not whether it is still good. A tax
              -- clearance uploaded in March and reused in December is the exact
              -- case, and "uploaded 9 months ago" is not the same statement as
              -- "expired".
              to_char(d.expires_on, 'YYYY-MM-DD') as expires_on,
              to_char(d.certified_on, 'YYYY-MM-DD') as certified_on,
              (d.status = 'Rejected' and not d.scan_cleared) as quarantined,
              d.application_id,
              a.reference_number as application_reference,
              d.review_status,
              row_number() over (partition by d.sha256
                                 order by (d.application_id is null) desc, d.uploaded_at desc, d.id) as rank
         from documents d
         left join applications a on a.id = d.application_id
        where d.uploaded_by = $1 and d.deleted_at is null and d.removed_from_library_at is null
       ), used as (
       select sha256, count(*)::text as copies,
              jsonb_agg(distinct jsonb_build_object('id', application_id, 'referenceNumber', application_reference))
                filter (where application_id is not null) as applications
         from library group by sha256
       )
       select library.*, used.copies, used.applications
         from library join used using (sha256)
        where library.rank = 1
        order by library.uploaded_at desc, library.id`,
      [accountId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      fileName: row.file_name,
      contentType: row.content_type,
      byteSize: row.byte_size,
      uploadedAt: row.uploaded_at.toISOString(),
      requirementCode: row.requirement_code,
      // Null means NO EXPIRY RECORDED, never "does not expire". A client should
      // say it does not know rather than imply the document is good for ever.
      expiresOn: row.expires_on,
      // When the issuing office certified it, which is NOT when it was
      // uploaded. Null means NOT RECORDED -- never a date, and never a blank
      // that reads as one. The citizen web lane had this falling back to the
      // upload date and removed it: that would tell an officer a document was
      // certified on the day it reached us.
      certifiedOn: row.certified_on,
      scanCleared: row.scan_cleared,
      quarantined: row.quarantined,
      // Null means unattached — genuinely reusable on any application. Set
      // means it is doing duty on a real filing right now; still reusable
      // (nothing about attaching a document consumes it), just no longer the
      // narrow "not yet filed" thing this list used to mean.
      applicationId: row.application_id,
      applicationReference: row.application_reference,
      // Null for an unattached document — nothing has reviewed it because
      // there is no application to review it against. Set once attached,
      // same vocabulary `GET /applications/:id/documents` already reports.
      reviewStatus: row.review_status,
      // Every application a copy of this file is on, the shown copy's own
      // included. Empty when no copy is attached anywhere.
      applications: (row.applications ?? [])
        .sort((a, b) => (a.referenceNumber ?? '').localeCompare(b.referenceNumber ?? '')),
      // How many copies stand behind this one entry (1 = only this one).
      copies: Number(row.copies),
    }));
  }

  /**
   * The citizen's own copy of a file, if they already have one in My
   * Documents: not deleted, not removed from the library, not quarantined.
   * The unattached copy first, as the one that can be used as it is.
   */
  private async copyOf(accountId: string, digest: string): Promise<ExistingCopy | null> {
    const result = await this.db.query<{
      id: string; file_name: string; label: string; application_reference: string | null;
    }>(
      `select d.id, d.file_name, d.label, a.reference_number as application_reference
         from documents d
         left join applications a on a.id = d.application_id
        where d.uploaded_by = $1 and d.sha256 = $2
          and d.deleted_at is null and d.removed_from_library_at is null
          and not (d.status = 'Rejected' and not d.scan_cleared)
        order by (d.application_id is null) desc, d.uploaded_at desc, d.id
        limit 1`,
      [accountId, digest],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      id: row.id, fileName: row.file_name, label: row.label, applicationReference: row.application_reference,
    };
  }

  /** Whether `reuseOf` names this citizen's own copy of exactly these bytes — a declared reuse, not a second upload. */
  private async isReuseOf(reuseOf: string | null, accountId: string, digest: string): Promise<boolean> {
    if (reuseOf === null || !/^[0-9a-fA-F-]{36}$/.test(reuseOf)) return false;
    const result = await this.db.query(
      'select 1 from documents where id = $1 and uploaded_by = $2 and sha256 = $3 and deleted_at is null',
      [reuseOf, accountId, digest],
    );
    return result.rows.length > 0;
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

    if (caller.kind === 'applicant') {
      await this.tellRecordsOfficers(applicationId, options.label, 'replaced');
    }

    return { kind: 'created', documentId: uploaded.documentId, status: uploaded.status,
      removedMetadata: uploaded.removedMetadata };
  }

  /**
   * The applicant's side of an adverse document verdict. Uses the catalogued
   * `letter-of-instruction-issued` type (category Document Reminders, so the
   * applicant's own preferences apply), with the document and the officer's
   * reason in the body and a link to the application itself.
   */
  private async tellApplicantDocumentReturned(
    tx: SqlClient, applicationId: string, documentId: string,
    status: 'Rejected' | 'Revision Required', remark: string | null,
  ): Promise<void> {
    const found = await tx.query<{ account_id: string; label: string; reference_number: string }>(
      `select ap.account_id, d.label, a.reference_number
         from documents d
         join applications a on a.id = d.application_id
         join applicants ap on ap.id = a.applicant_id
        where d.id = $1 and a.id = $2`,
      [documentId, applicationId],
    );
    const row = found.rows[0];
    if (row === undefined) return;
    const verb = status === 'Rejected' ? 'was not accepted' : 'needs to be replaced';
    await tx.query(
      `insert into notifications (account_id, type, application_id, title, body, deep_link)
       values ($1, 'letter-of-instruction-issued', $2, $3, $4, $5)`,
      [
        row.account_id, applicationId,
        'A document needs your attention',
        `"${row.label}" on ${row.reference_number} ${verb}.${remark ? ` Reason: ${remark}` : ''} `
          + 'Open your application to replace it.',
        `/applications/${applicationId}`,
      ],
    );
  }

  /**
   * Tells the Records Officers -- the role that reviews documents -- that an
   * applicant has sent a new or replacement document on a filed application,
   * so it does not sit unreviewed until someone happens to open the record.
   * Names the reference and the document, never the applicant (the staff
   * catalogue's rule). Best-effort: the upload has already happened.
   */
  private async tellRecordsOfficers(
    applicationId: string, label: string, how: 'replaced' | 'added',
  ): Promise<void> {
    const app = await this.db.query<{ reference_number: string; lifecycle_status: string }>(
      'select reference_number, lifecycle_status from applications where id = $1', [applicationId],
    );
    const row = app.rows[0];
    if (row === undefined || row.lifecycle_status === 'Draft') return;
    await this.db.query(
      `insert into staff_notifications
         (account_id, type, application_id, routed_to_role, title, body, deep_link)
       select a.id, 'document-resubmitted', $1, 'records-officer', $2, $3, $4
         from accounts a
         join account_roles r on r.account_id = a.id
        where r.role = 'records-officer' and a.kind = 'staff' and a.disabled_at is null
       on conflict do nothing`,
      [
        applicationId,
        `${row.reference_number}: document ${how}`,
        `The applicant ${how} "${label}" on ${row.reference_number}. Review it in the Documents tab.`,
        `/staff/applications/${applicationId}`,
      ],
    );
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

    // A clean verdict is the scanner's own approval, not a placeholder
    // waiting on a later approver -- nothing else in this codebase ever
    // writes 'Approved' (confirmed by grep: applyVerdict is the only writer
    // of this column after insert), so leaving it 'Pending' here meant no
    // document could ever reach 'Approved' through any real path. That in
    // turn left `identity_document_verified` unsatisfiable a second way,
    // even after the label-matching fix: it also requires `d.status =
    // 'Approved'`, which nothing had ever set.
    await this.db.query(
      `update documents set status = 'Approved', scan_cleared = true, scanned_at = $1 where id = $2`,
      [result.scannedAt, documentId],
    );
    return 'Approved';
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
   * A citizen removing their own copy from "My Documents".
   *
   * Two different things happen underneath the one action, depending on
   * whether the document is currently attached:
   *
   * UNATTACHED: a real deletion. Nothing else references it, so the object
   * bytes are purged from the store and `deleted_at` is set — the same soft
   * delete `runRetention` already uses, the citizen-initiated case of the
   * one mechanism that already exists.
   *
   * ATTACHED: only `removed_from_library_at` is set (migration 052). The
   * bytes, the row, and everything an officer sees on that application are
   * untouched — an attached document is evidence on a real permit record
   * (RA 8792), and `GET /applications/:id/documents` must keep showing it
   * exactly as filed. This only stops it being OFFERED again: excluded from
   * `historyFor` (the library listing "My Documents" and document-reuse are
   * both built from), so there is nothing left for the citizen to pick it
   * back up from. A citizen who wants it gone from the filing itself has to
   * withdraw or resubmit on the application, not here.
   *
   * Both branches always succeed once ownership is confirmed — there used
   * to be a third, 'attached', refusal here; an attached document is no
   * longer refused, it takes the softer path instead.
   *
   * Every copy of the file goes (2026-09-29): My Documents shows a file once
   * however many copies stand behind it (see `historyFor`), so removing one
   * copy would only bring the next one into view. Each copy takes its own
   * branch above; copies on applications stay exactly as filed.
   */
  async deleteMine(documentId: string, caller: Caller): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: 'not-found' }
  > {
    const document = await this.load(documentId);

    // 404, not 403, for the same reason contentUrl above gives one — telling
    // an applicant "that belongs to someone else" is itself a disclosure.
    if (document === null || !ownedBy(document, caller.accountId)) {
      return { ok: false, reason: 'not-found' };
    }

    const copies = await this.db.query<{ id: string }>(
      `select id from documents
        where uploaded_by = $1 and sha256 = $2 and id <> $3
          and deleted_at is null and removed_from_library_at is null`,
      [caller.accountId, document.sha256, document.id],
    );
    for (const copy of copies.rows) {
      const loaded = await this.load(copy.id);
      if (loaded !== null) await this.removeOne(loaded, caller);
    }
    await this.removeOne(document, caller);
    return { ok: true };
  }

  /** One copy out of My Documents: deleted when unattached, only hidden when it is on an application. */
  private async removeOne(document: DocumentRow, caller: Caller): Promise<void> {
    if (document.application_id === null) {
      await this.store.delete(document.storage_key);
      await this.db.query('update documents set deleted_at = $1 where id = $2', [this.clock(), document.id]);
      await this.audit.append({
        action: 'document.deleted-by-citizen',
        subjectType: 'document',
        subjectId: document.id,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: caller.kind,
      });
      return;
    }

    await this.db.query(
      'update documents set removed_from_library_at = $1 where id = $2', [this.clock(), document.id],
    );
    await this.audit.append({
      action: 'document.removed-from-library',
      subjectType: 'document',
      subjectId: document.id,
      outcome: 'allowed',
      actorAccountId: caller.accountId,
      actorRole: caller.kind,
    });
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
  async runRetention(retainForDays: number): Promise<{
    deleted: number; skippedOpen: number; abandoned: number;
  }> {
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

    // ── Uploads that were never filed (C-7) ────────────────────────────────
    //
    // A document created by `POST /documents` and never attached is invisible
    // to every mechanism that would otherwise handle it. The query above joins
    // `applications` to find the closing transition that starts the clock, so
    // an orphan is dropped by the INNER JOIN and can never become eligible --
    // not "is not yet eligible", but cannot be, by construction. Nothing lists
    // it either, and erasure does not delete it.
    //
    // So a PSA birth certificate or a lot plan carrying a home address,
    // uploaded during a wizard session somebody abandoned, was held for ever
    // with no purpose: nobody's permit record, and nobody's to find.
    //
    // The clock is `uploaded_at`, because there is no closure event to read.
    //
    // THE PERIOD IS THE LGU'S, and the same one, deliberately. An abandoned
    // upload arguably deserves a SHORTER clock than a closed permit's file --
    // it is not part of any record -- but choosing that number here would be
    // the data-minimisation decision this method already refuses to make on
    // the LGU's behalf. Reported separately so an operator can see the
    // difference and ask for one.
    const abandoned = await this.db.query<{ id: string; storage_key: string }>(
      `select d.id, d.storage_key
         from documents d
        where d.deleted_at is null
          and d.application_id is null
          and d.uploaded_at < $1`,
      [cutoff],
    );

    for (const document of abandoned.rows) {
      await this.store.delete(document.storage_key);
      await this.db.query('update documents set deleted_at = $1 where id = $2',
        [this.clock(), document.id]);
      await this.audit.append({
        action: 'document.deleted-on-retention',
        subjectType: 'document',
        subjectId: document.id,
        outcome: 'allowed',
      });
    }

    return {
      deleted: eligible.rows.length,
      skippedOpen: Number(open.rows[0]?.n ?? 0),
      abandoned: abandoned.rows.length,
    };
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
