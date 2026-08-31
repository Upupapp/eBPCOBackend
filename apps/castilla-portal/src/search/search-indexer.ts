import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

/**
 * Rebuilds the search index from the published content.
 *
 * The document for an office reaches deliberately beyond its own row: its
 * services, and the NAMES OF THE PERMITS IT ISSUES. That relationship is the
 * whole point. The Municipal Planning and Development Office contains the word
 * 'zoning' in none of its own fields, and it is the office a citizen searching
 * 'zoning' is looking for.
 *
 * Equally deliberate is what is left out. A head that is not confirmed and a
 * contact that is pending or withheld are excluded by the same predicates the
 * read API uses, because an index that quietly contains a withheld phone number
 * is a way to READ it: type the number and see whose office comes back.
 */
@Injectable()
export class SearchIndexer {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  async rebuild(): Promise<{ offices: number; permits: number }> {
    await this.db.query('delete from search_documents');

    const offices = await this.db.query<{ n: number }>(`
      with services as (
        select office_id, string_agg(service, ' ') as text
          from office_services group by office_id
      ),
      issued as (
        -- The permits an office issues, by name. This is what makes 'zoning',
        -- 'occupancy', 'demolition' and 'fencing' find their office.
        select p.issuing_office_id as office_id, string_agg(p.name, ' ') as text
          from permits p
         where p.issuing_office_id is not null
         group by p.issuing_office_id
      ),
      head as (
        -- Only a CONFIRMED head. The same state gate /offices uses.
        select o.id as office_id, coalesce(x.name, o.head_name) as text
          from offices o
          left join officials x on x.id = o.head_official_id
          join field_state fs on fs.entity_type = 'office'
           and fs.entity_id = o.id::text and fs.field_name = 'head'
         where fs.state = 'confirmed'
      ),
      contacts as (
        -- Only CONFIRMED contact values. A pending or withheld one must not be
        -- searchable, or the index becomes a way to read it.
        select c.office_id, string_agg(c.value, ' ') as text
          from office_contacts c
          join field_state fs on fs.entity_type = 'office'
           and fs.entity_id = c.office_id::text
           and fs.field_name = 'contact.' || c.field_name
         where fs.state = 'confirmed'
         group by c.office_id
      )
      insert into search_documents (entity_type, entity_id, slug, title, summary, facet, document)
      select 'office', o.id, o.slug, o.name, o.short_description, o.category_id,
             setweight(to_tsvector('english', o.name), 'A')
          || setweight(to_tsvector('english', o.short_description), 'B')
          || setweight(to_tsvector('english', coalesce(h.text, '')), 'B')
          || setweight(to_tsvector('english', coalesce(ct.text, '')), 'B')
          || setweight(to_tsvector('english', o.about_text), 'C')
          || setweight(to_tsvector('english', coalesce(s.text, '')), 'C')
          || setweight(to_tsvector('english', coalesce(i.text, '')), 'C')
        from offices o
        left join services s  on s.office_id = o.id
        left join issued   i  on i.office_id = o.id
        left join head     h  on h.office_id = o.id
        left join contacts ct on ct.office_id = o.id
      returning 1 as n`);

    const permits = await this.db.query<{ n: number }>(`
      with requirements as (
        select permit_id, string_agg(requirement, ' ') as text
          from permit_requirements group by permit_id
      )
      insert into search_documents (entity_type, entity_id, slug, title, summary, facet, document)
      select 'permit', p.id, p.slug, p.name, p.description, p.office_group_id,
             setweight(to_tsvector('english', p.name), 'A')
          || setweight(to_tsvector('english', p.description), 'B')
          -- The issuing body's name, so 'Bureau of Fire Protection' finds the
          -- two BFP permits even though no municipal office issues them.
          || setweight(to_tsvector('english', p.issuing_office_name), 'B')
          || setweight(to_tsvector('english', coalesce(r.text, '')), 'C')
        from permits p
        left join requirements r on r.permit_id = p.id
      returning 1 as n`);

    return { offices: offices.rows.length, permits: permits.rows.length };
  }
}
