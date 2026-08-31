import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface StoredForm {
  id: string;
  familySlug: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  pageCount: number;
  checksum: string;
  revisionLabel?: string;
  isCurrent: boolean;
}

export interface FormBytes {
  bytes: Buffer;
  contentType: string;
  originalFilename: string;
}

interface FormRow {
  id: string;
  family_slug: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  page_count: number;
  checksum: string;
  revision_label: string | null;
  superseded_at: Date | null;
}

/**
 * A module function rather than a static, so it can be passed to `.map`
 * without an unbound `this` — which is a real hazard here, not a style note.
 */
function describe(row: FormRow): StoredForm {
  const form: StoredForm = {
    id: row.id, familySlug: row.family_slug, originalFilename: row.original_filename,
    contentType: row.content_type, byteSize: Number(row.byte_size),
    pageCount: Number(row.page_count), checksum: row.checksum,
    isCurrent: row.superseded_at === null,
  };
  // Absent where the form prints none — 10 of the 13 do not.
  if (row.revision_label !== null) form.revisionLabel = row.revision_label;
  return form;
}

const COLUMNS = `id, family_slug, original_filename, content_type, byte_size, page_count,
                 checksum, revision_label, superseded_at`;

@Injectable()
export class FormsRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /** Current revisions only: the list is what a citizen should be filing today. */
  async list(): Promise<StoredForm[]> {
    const { rows } = await this.db.query<FormRow>(
      `select ${COLUMNS} from forms
        where superseded_at is null order by original_filename`);
    return rows.map(describe);
  }

  /** Every revision of one family, newest first, so a superseded form stays findable. */
  async revisions(familySlug: string): Promise<StoredForm[]> {
    const { rows } = await this.db.query<FormRow>(
      `select ${COLUMNS} from forms
        where family_slug = $1 order by imported_at desc`, [familySlug]);
    return rows.map(describe);
  }

  /**
   * The bytes to serve.
   *
   * A bare family slug serves the CURRENT revision; a checksum pins one exact
   * revision forever, which is what makes 'the form I filed on' a thing a
   * citizen can still retrieve.
   */
  async bytesOf(familySlug: string, checksum?: string): Promise<FormBytes | null> {
    const { rows } = await this.db.query<{
      bytes: Buffer; content_type: string; original_filename: string;
    }>(
      checksum === undefined
        ? `select bytes, content_type, original_filename from forms
            where family_slug = $1 and superseded_at is null`
        : `select bytes, content_type, original_filename from forms
            where family_slug = $1 and checksum = $2`,
      checksum === undefined ? [familySlug] : [familySlug, checksum],
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      bytes: Buffer.from(row.bytes),
      contentType: row.content_type,
      originalFilename: row.original_filename,
    };
  }
}
