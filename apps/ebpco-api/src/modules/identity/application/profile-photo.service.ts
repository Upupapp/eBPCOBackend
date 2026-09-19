import { SqlClient } from '../../../persistence/sql-client';
import { inspect } from '../../documents/domain/content-inspection';
import { scrub } from '../../documents/domain/metadata-scrubber';
import { MalwareScanner } from '../../documents/domain/malware-scanner';
import { ObjectStore, newObjectKey } from '../../documents/domain/object-store';
import { AuditService } from '../../compliance/application/audit.service';

/**
 * A citizen's own profile photo — User Portal Profile screen.
 *
 * The bytes live in the object store, exactly the same architecture
 * `DocumentService.upload()` uses for a permit attachment, and for the same
 * reason: "never the database". This is a smaller, purpose-built sibling
 * rather than a call into `DocumentService` itself, because that service's
 * whole shape — an `application_id`, a requirement code, a staff review
 * workflow, a malware-scan status the applicant can query later — answers
 * questions a profile photo does not have. There is no application here, no
 * officer reviews this, and the caller finds out whether it was accepted in
 * the same request that uploaded it.
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type UploadPhotoOutcome =
  | { readonly ok: true; readonly contentType: 'image/jpeg' | 'image/png' }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface StoredPhoto {
  readonly contentType: 'image/jpeg' | 'image/png';
  readonly bytes: Buffer;
}

export class ProfilePhotoService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly store: ObjectStore,
    private readonly scanner: MalwareScanner,
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db);
  }

  async upload(accountId: string, bytes: Buffer, fileName: string): Promise<UploadPhotoOutcome> {
    const inspection = inspect(bytes, fileName, MAX_PHOTO_BYTES);
    if (!inspection.ok) {
      return { ok: false, reason: inspection.failure.reason, detail: inspection.failure.detail };
    }
    if (inspection.inspection.format === 'application/pdf') {
      return {
        ok: false, reason: 'not-an-image',
        detail: 'A profile photo must be a JPEG or PNG image, not a PDF.',
      };
    }
    const format = inspection.inspection.format;

    // Scrubbed before it is scanned or stored, same order `DocumentService
    // .upload()` uses: the checksum and the bytes on disk must describe what
    // is kept, not what the citizen originally sent — a photo taken on a
    // phone routinely carries the GPS coordinates of where it was taken.
    const scrubbed = scrub(bytes, format);
    const verdict = await this.scanner.scan(scrubbed.bytes);
    if (verdict.verdict === 'infected') {
      return {
        ok: false, reason: 'infected',
        detail: 'This file was rejected because it failed a malware check. Choose a different photo.',
      };
    }

    // Read before the write: `UPDATE ... RETURNING` reflects the row AFTER
    // the update, so the only way to learn what it replaced is to ask first.
    const before = await this.db.query<{ photo_key: string | null }>(
      'select photo_key from accounts where id = $1', [accountId],
    );
    const previousKey = before.rows[0]?.photo_key ?? null;

    const key = newObjectKey();
    await this.store.put(key, scrubbed.bytes, format);
    await this.db.query(
      'update accounts set photo_key = $2, photo_content_type = $3 where id = $1',
      [accountId, key, format],
    );

    // Best-effort, same reasoning as the erasure path: the new photo is
    // already saved and already the account's photo of record by the time
    // this runs, and a failed cleanup of the OLD object is a storage cost,
    // not a reason to report the upload itself as failed.
    if (previousKey !== null) {
      await this.store.delete(previousKey).catch(() => undefined);
    }

    await this.audit.append({
      action: 'profile.photo-changed',
      subjectType: 'account',
      subjectId: accountId,
      outcome: 'allowed',
      actorAccountId: accountId,
      actorRole: 'applicant',
    });

    return { ok: true, contentType: format };
  }

  async remove(accountId: string): Promise<void> {
    const current = await this.db.query<{ photo_key: string | null }>(
      'select photo_key from accounts where id = $1', [accountId],
    );
    const key = current.rows[0]?.photo_key ?? null;
    if (key === null) return;

    await this.db.query(
      'update accounts set photo_key = null, photo_content_type = null where id = $1', [accountId],
    );
    await this.store.delete(key).catch(() => undefined);

    await this.audit.append({
      action: 'profile.photo-removed',
      subjectType: 'account',
      subjectId: accountId,
      outcome: 'allowed',
      actorAccountId: accountId,
      actorRole: 'applicant',
    });
  }

  /** Whether `GET /me` should advertise a photo — one indexed read, no object-store round trip. */
  async hasPhoto(accountId: string): Promise<boolean> {
    const result = await this.db.query<{ photo_key: string | null }>(
      'select photo_key from accounts where id = $1', [accountId],
    );
    return (result.rows[0]?.photo_key ?? null) !== null;
  }

  /** The actual bytes, for `GET /me/photo`. Null for no photo OR a key the store can no longer find. */
  async photoFor(accountId: string): Promise<StoredPhoto | null> {
    const result = await this.db.query<{ photo_key: string | null; photo_content_type: string | null }>(
      'select photo_key, photo_content_type from accounts where id = $1', [accountId],
    );
    const row = result.rows[0];
    if (row === undefined || row.photo_key === null || row.photo_content_type === null) return null;

    const bytes = await this.store.get(row.photo_key);
    if (bytes === null) return null;

    return { contentType: row.photo_content_type as 'image/jpeg' | 'image/png', bytes };
  }
}
