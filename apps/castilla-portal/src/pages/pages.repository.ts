import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface ContentPage {
  key: string;
  title: string;
  body: string;
  /** 'pending' | 'confirmed' — the same gate every other field in this schema uses. */
  state: 'pending' | 'confirmed';
  /**
   * True when the body stands in for content the LGU has not supplied. Distinct
   * from `state`: a page can be an honest, sourced description of a placeholder
   * situation, and the client renders the two differently.
   */
  isPlaceholder: boolean;
  sourceNote?: string;
  updatedAt: string;
}

export interface PageRevision {
  title: string;
  body: string;
  isPlaceholder: boolean;
  author: string;
  recordedAt: string;
}

@Injectable()
export class PagesRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  private static readonly SELECT = `
    select p.key, p.title, p.body, p.is_placeholder, p.source_note, p.updated_at,
           coalesce(fs.state::text, 'pending') as state
      from content_pages p
      left join field_state fs
             on fs.entity_type = 'page' and fs.entity_id = p.key and fs.field_name = 'body'`;

  /**
   * A pending page IS served, with its text and a flag saying so.
   *
   * The opposite of the rule for offices, and deliberately: withholding here
   * would give a citizen an empty page where the site currently shows an honest
   * 'pending publication by LGU Castilla' notice. Silence would be a downgrade,
   * not a safeguard.
   */
  async byKey(key: string): Promise<ContentPage | null> {
    const { rows } = await this.db.query<{
      key: string; title: string; body: string; is_placeholder: boolean;
      source_note: string | null; updated_at: Date; state: string;
    }>(`${PagesRepository.SELECT} where p.key = $1`, [key]);

    const row = rows[0];
    if (row === undefined) return null;

    const page: ContentPage = {
      key: row.key, title: row.title, body: row.body,
      state: row.state === 'confirmed' ? 'confirmed' : 'pending',
      isPlaceholder: row.is_placeholder,
      updatedAt: row.updated_at.toISOString(),
    };
    if (row.source_note !== null) page.sourceNote = row.source_note;
    return page;
  }

  async list(): Promise<ContentPage[]> {
    const { rows } = await this.db.query<{ key: string }>(
      'select key from content_pages order by ordinal');
    const pages: ContentPage[] = [];
    for (const row of rows) {
      const page = await this.byKey(row.key);
      if (page !== null) pages.push(page);
    }
    return pages;
  }

  /** Newest first. The placeholder must stay readable after the LGU replaces it. */
  async revisions(key: string): Promise<PageRevision[]> {
    const { rows } = await this.db.query<{
      title: string; body: string; is_placeholder: boolean;
      author: string; recorded_at: Date;
    }>(
      `select title, body, is_placeholder, author, recorded_at
         from content_page_revisions where key = $1 order by recorded_at desc, id`, [key]);

    return rows.map((row) => ({
      title: row.title, body: row.body, isPlaceholder: row.is_placeholder,
      author: row.author, recordedAt: row.recorded_at.toISOString(),
    }));
  }
}
