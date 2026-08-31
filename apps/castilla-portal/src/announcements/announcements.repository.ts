import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';
import { AnnouncementState, isReadable, stateOf } from './announcement';
import { renderBody } from './body';

export interface AnnouncementSummary {
  slug: string;
  title: string;
  category: string;
  publishedAt: string;
  expiresAt?: string;
  state: AnnouncementState;
}

export interface AnnouncementDetail extends AnnouncementSummary {
  body: string;
  bodyHtml: string;
  attachment?: { familySlug: string; originalFilename: string; downloadUrl: string };
}

interface Row {
  slug: string; title: string; body: string; category: string;
  status: 'draft' | 'published' | 'withdrawn';
  published_at: Date | null; expires_at: Date | null;
  attachment_family: string | null; attachment_filename: string | null;
}

/**
 * The clock is a parameter, not a call to `now()` inside a query.
 *
 * Scheduling and expiry are the whole point of this table, and a test that
 * cannot move the clock can only assert them by sleeping. Production passes the
 * real time; the tests pass whichever moment they are making a claim about.
 */
@Injectable()
export class AnnouncementsRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  private static readonly SELECT = `
    select a.slug, a.title, a.body, a.category, a.status::text as status,
           a.published_at, a.expires_at,
           f.family_slug as attachment_family, f.original_filename as attachment_filename
      from announcements a
      left join forms f on f.id = a.attachment_form_id`;

  /**
   * Published and live, newest first.
   *
   * The window is closed in SQL rather than filtered afterwards: a draft or a
   * scheduled announcement must never be read out of the database at all, so
   * there is no object in memory that a later change could accidentally serve.
   */
  async list(now: Date, limit: number, offset: number): Promise<{
    announcements: AnnouncementSummary[]; total: number;
  }> {
    const { rows } = await this.db.query<Row>(
      `${AnnouncementsRepository.SELECT}
        where a.status = 'published'
          and a.published_at <= $1
          and (a.expires_at is null or a.expires_at > $1)
        order by a.published_at desc, a.slug
        limit $2 offset $3`,
      [now, limit, offset],
    );

    return {
      announcements: rows.map((row) => this.summarise(row, now)),
      total: await this.count(now),
    };
  }

  /**
   * The header badge's number, in ONE query and nothing else.
   *
   * It is called on every page load, so it reads a partial index and returns a
   * single integer — no rows, no joins, no body text crossing the wire to be
   * counted and thrown away.
   */
  async count(now: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `select count(*)::int as n from announcements
        where status = 'published' and published_at <= $1
          and (expires_at is null or expires_at > $1)`,
      [now],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * One announcement by slug, INCLUDING an expired one.
   *
   * A link shared on Facebook must not rot the moment the notice lapses — the
   * reader is told it expired rather than told it never existed. A draft, a
   * scheduled announcement and a withdrawn one all return null: not-yet-public
   * and no-longer-public are both none of the reader's business.
   */
  async bySlug(slug: string, now: Date): Promise<AnnouncementDetail | null> {
    const { rows } = await this.db.query<Row>(
      `${AnnouncementsRepository.SELECT} where a.slug = $1`, [slug]);

    const row = rows[0];
    if (row === undefined) return null;

    const state = stateOf({
      status: row.status,
      publishedAt: row.published_at, expiresAt: row.expires_at,
    }, now);
    if (!isReadable(state)) return null;

    const detail: AnnouncementDetail = {
      ...this.summarise(row, now),
      body: row.body,
      bodyHtml: renderBody(row.body),
    };
    if (row.attachment_family !== null && row.attachment_filename !== null) {
      detail.attachment = {
        familySlug: row.attachment_family,
        originalFilename: row.attachment_filename,
        downloadUrl: `/forms/${row.attachment_family}/download`,
      };
    }
    return detail;
  }

  private summarise(row: Row, now: Date): AnnouncementSummary {
    const summary: AnnouncementSummary = {
      slug: row.slug, title: row.title, category: row.category,
      publishedAt: (row.published_at ?? new Date(0)).toISOString(),
      state: stateOf({
        status: row.status, publishedAt: row.published_at, expiresAt: row.expires_at,
      }, now),
    };
    if (row.expires_at !== null) summary.expiresAt = row.expires_at.toISOString();
    return summary;
  }
}
