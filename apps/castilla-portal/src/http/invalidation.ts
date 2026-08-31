import { SqlClient } from '../persistence/sql-client';
import { ContentVersions } from './cache';

/**
 * Which cached responses a change actually affects.
 *
 * Written as a map rather than scattered `bump()` calls, so the question "what
 * does confirming an office contact expire?" has one answer that can be read.
 *
 * Note what is NOT here: proposing. A proposal changes nothing a citizen can
 * read, so expiring caches for one would be pure waste — and worse, it would
 * make the cache noisy enough that nobody trusts it.
 */
export async function invalidateFor(
  versions: ContentVersions, db: SqlClient, entityType: string, entityId: string,
): Promise<void> {
  switch (entityType) {
    case 'office': {
      // The slug, because that is what the URL and therefore the cache key
      // uses. One query, on an event that happens a few times a term.
      const { rows } = await db.query<{ slug: string }>(
        'select slug from offices where id::text = $1', [entityId]);
      const slug = rows[0]?.slug;
      versions.bump('offices', 'search', ...(slug === undefined ? [] : [`office:${slug}`]));
      return;
    }
    case 'official': {
      // An official's name appears on their own record AND as an office head,
      // so both expire. Missing the second is how a renamed Mayor stays renamed
      // on one page and not the other.
      const { rows } = await db.query<{ slug: string }>(
        `select o.slug from offices o where o.head_official_id::text = $1`, [entityId]);
      versions.bump('officials', 'offices', 'search',
        ...rows.map((row) => `office:${row.slug}`));
      return;
    }
    case 'permit': {
      // A permit's name and description show on the permit page, in the
      // catalogue, AND inside every office that issues it.
      const { rows } = await db.query<{ permit: string; office: string | null }>(
        `select p.slug as permit, o.slug as office from permits p
           left join offices o on o.id = p.issuing_office_id
          where p.id::text = $1`, [entityId]);
      const row = rows[0];
      versions.bump('permits', 'search',
        ...(row === undefined ? [] : [`permit:${row.permit}`]),
        ...(row === undefined || row.office === null
          ? [] : ['offices', `office:${row.office}`]));
      return;
    }
    case 'page':
      versions.bump('pages', `page:${entityId}`);
      return;
    case 'announcement':
      versions.bump('announcements');
      return;
    case 'profile':
      versions.bump('municipality');
      return;
    default:
      // An entity type nobody mapped. Expire the broad collections rather than
      // nothing: a stale public fact is worse than a wasted revalidation.
      versions.bump('offices', 'permits', 'officials', 'pages', 'municipality', 'search');
  }
}
