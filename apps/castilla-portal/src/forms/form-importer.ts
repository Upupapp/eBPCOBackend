import { createHash } from 'node:crypto';

import { SqlClient } from '../persistence/sql-client';
import { pageCount, revisionLabel } from './pdf';

export interface BundledFile {
  readonly filename: string;
  readonly bytes: Buffer;
}

export interface ImportReport {
  readonly imported: number;
  readonly unchanged: number;
  readonly superseded: number;
  readonly linked: number;
  /** Bundled files no permit references. Reported, never attached to a guess. */
  readonly orphans: string[];
  /** Permit references naming a file that is not bundled. */
  readonly dangling: string[];
  readonly rejected: { file: string; reason: string }[];
}

const CONTENT_TYPES: Readonly<Record<string, string>> = { pdf: 'application/pdf' };

export function familySlugFor(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Imports the bundled forms and reconciles them against the permits that cite
 * them.
 *
 * Two rules shape the whole thing. The bytes are stored EXACTLY as received —
 * these are the LGU's and the BFP's own documents, and re-generating or
 * flattening them would mean serving a citizen something the municipality never
 * issued. And a file nobody references is REPORTED rather than attached to a
 * plausible permit: an orphan is either a missing link or a file that should
 * not ship, and only a person can say which.
 */
export class FormImporter {
  constructor(private readonly db: SqlClient) {}

  async run(files: readonly BundledFile[]): Promise<ImportReport> {
    let imported = 0;
    let unchanged = 0;
    let superseded = 0;
    const rejected: { file: string; reason: string }[] = [];

    for (const file of files) {
      const extension = file.filename.split('.').pop()?.toLowerCase() ?? '';
      const contentType = CONTENT_TYPES[extension];
      if (contentType === undefined) {
        rejected.push({ file: file.filename, reason: `unsupported file type '.${extension}'` });
        continue;
      }
      const pages = pageCount(file.bytes);
      if (pages === null) {
        // A file whose page count cannot be read is not a form this API can
        // describe honestly, and guessing 1 would publish a claim nobody made.
        rejected.push({ file: file.filename, reason: 'no readable page count' });
        continue;
      }

      const checksum = createHash('sha256').update(file.bytes).digest('hex');
      const family = familySlugFor(file.filename);

      const current = await this.db.query<{ id: string; checksum: string }>(
        `select id, checksum from forms
          where family_slug = $1 and superseded_at is null`, [family]);
      const live = current.rows[0];

      if (live !== undefined && live.checksum === checksum) {
        unchanged += 1;
        continue;
      }
      if (live !== undefined) {
        // The prior revision stays retrievable: an application filed on last
        // year's form is still a real application.
        await this.db.query('update forms set superseded_at = now() where id = $1', [live.id]);
        superseded += 1;
      }

      await this.db.query(
        `insert into forms (family_slug, original_filename, content_type, byte_size,
                            page_count, checksum, revision_label, bytes)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (family_slug, checksum) do update set superseded_at = null`,
        [family, file.filename, contentType, file.bytes.length, pages, checksum,
         revisionLabel(file.bytes), file.bytes],
      );
      imported += 1;
    }

    const { linked, orphans, dangling } = await this.reconcile();
    return { imported, unchanged, superseded, linked, orphans, dangling, rejected };
  }

  /**
   * Links each permit to the forms it cites, and names what did not match.
   *
   * The permits already carry `/assets/permits/<filename>` from the portal's
   * own data. Matching on that filename rather than on a hand-kept mapping is
   * what makes an orphan detectable at all.
   */
  private async reconcile(): Promise<{ linked: number; orphans: string[]; dangling: string[] }> {
    const references = await this.db.query<{
      permit_id: string; role: string; filename: string;
    }>(
      `select p.id as permit_id, 'application' as role,
              regexp_replace(p.form_url, '^/assets/permits/', '') as filename
         from permits p where p.form_url is not null
        union all
       select p.id, 'checklist',
              regexp_replace(p.checklist_url, '^/assets/permits/', '')
         from permits p where p.checklist_url is not null`,
    );

    const stored = await this.db.query<{ id: string; original_filename: string }>(
      'select id, original_filename from forms where superseded_at is null');
    const byFilename = new Map(stored.rows.map((row) => [row.original_filename, row.id]));

    let linked = 0;
    const dangling = new Set<string>();
    const referenced = new Set<string>();

    for (const reference of references.rows) {
      const formId = byFilename.get(reference.filename);
      if (formId === undefined) {
        // A permit citing a form nobody bundled. The download link on that
        // permit is already dead on the live site.
        dangling.add(reference.filename);
        continue;
      }
      referenced.add(reference.filename);
      const result = await this.db.query<{ permit_id: string }>(
        `insert into permit_forms (permit_id, form_id, role)
         values ($1,$2,$3) on conflict do nothing
         returning permit_id`,
        [reference.permit_id, formId, reference.role],
      );
      linked += result.rows.length;
    }

    const orphans = [...byFilename.keys()].filter((name) => !referenced.has(name)).sort();
    return { linked, orphans, dangling: [...dangling].sort() };
  }
}
