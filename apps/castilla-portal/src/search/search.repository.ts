import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface SearchResult {
  entityType: 'office' | 'permit';
  slug: string;
  title: string;
  summary: string;
  facet?: string;
  score: number;
}

export interface SearchQuery {
  readonly term?: string;
  readonly entityType?: 'office' | 'permit';
  readonly facet?: string;
  readonly limit: number;
}

@Injectable()
export class SearchRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * `websearch_to_tsquery`, not a LIKE over two columns.
   *
   * TAB 08 exists because of a LIKE over two columns, so this is the one place
   * the implementation choice IS the requirement. `websearch_to_tsquery` also
   * gives citizens the syntax they already expect from a search box — quoted
   * phrases, `or`, a leading minus — without this service parsing anything.
   *
   * Exact matching only. Fuzzy matching before exact matching is correct is how
   * a search that misses 'zoning' starts returning 'zoo' instead.
   */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const term = query.term?.trim() ?? '';
    const hasTerm = term !== '';

    const { rows } = await this.db.query<{
      entity_type: 'office' | 'permit'; slug: string; title: string;
      summary: string; facet: string | null; score: number;
    }>(
      `select d.entity_type, d.slug, d.title, d.summary, d.facet,
              case when $1::text is null then 0
                   else ts_rank(d.document, websearch_to_tsquery('english', $1)) end as score
         from search_documents d
        where ($1::text is null or d.document @@ websearch_to_tsquery('english', $1))
          and ($2::text is null or d.entity_type = $2)
          and ($3::text is null or d.facet = $3)
        -- Offices before permits at equal relevance: someone searching
        -- 'demolition' wants to know where to go, and the permit page is one
        -- click from the office page either way.
        order by score desc, (d.entity_type = 'office') desc, d.title
        limit $4`,
      [hasTerm ? term : null, query.entityType ?? null, query.facet ?? null, query.limit],
    );

    return rows.map((row) => {
      const result: SearchResult = {
        entityType: row.entity_type, slug: row.slug, title: row.title,
        summary: row.summary, score: Number(row.score),
      };
      if (row.facet !== null) result.facet = row.facet;
      return result;
    });
  }
}
