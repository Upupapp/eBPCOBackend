import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface OfficeSummary {
  slug: string;
  name: string;
  category: string;
  shortDescription: string;
}

export interface OfficeHead {
  name: string;
  position: string;
}

export interface OfficeDetail extends OfficeSummary {
  aboutText: string;
  services: string[];
  head?: OfficeHead;
  contact?: Record<string, string>;
  relatedOffices: { slug: string; name: string }[];
  issuedPermits: { slug: string; name: string }[];
}

/**
 * Reads for the public portal.
 *
 * ONE rule governs this whole file: a field the LGU has not confirmed does not
 * appear. Not as null, not as an empty string, and above all not as the string
 * 'Pending confirmation' — that sentinel exists in the current front end only
 * because a static array had no way to express "we don't know", and an API that
 * reproduced it would make a workaround permanent.
 *
 * Omission is enforced in SQL rather than filtered in TypeScript, so a field
 * that is not confirmed is never read out of the database in the first place.
 */
@Injectable()
export class OfficesRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * The committed order, never alphabetical: it groups executive offices first
   * and TAB 03 forbids re-sorting. A set has no order, so `ordinal` carries it.
   */
  async list(category?: string): Promise<OfficeSummary[]> {
    const { rows } = await this.db.query<OfficeSummary>(
      `select o.slug, o.name, o.category_id as category, o.short_description as "shortDescription"
         from offices o
        where ($1::text is null or o.category_id = $1)
        order by o.ordinal`,
      [category ?? null],
    );
    return rows;
  }

  async categories(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      'select id from office_categories order by ordinal');
    return rows.map((row) => row.id);
  }

  async detail(slug: string): Promise<OfficeDetail | null> {
    const { rows } = await this.db.query<{
      id: string; slug: string; name: string; category: string;
      shortDescription: string; aboutText: string;
      headName: string | null; headPosition: string | null;
    }>(
      `select o.id, o.slug, o.name, o.category_id as category,
              o.short_description as "shortDescription", o.about_text as "aboutText",
              -- The head is served only when its confirmation state says so, and
              -- the name comes from whichever source that office uses: the
              -- elected roster, or a name written on the office itself.
              case when fs.state = 'confirmed'
                   then coalesce(x.name, o.head_name) end as "headName",
              case when fs.state = 'confirmed'
                   then coalesce(x.position, o.head_position) end as "headPosition"
         from offices o
         left join officials x on x.id = o.head_official_id
         left join field_state fs
                on fs.entity_type = 'office' and fs.entity_id = o.id::text
               and fs.field_name = 'head'
        where o.slug = $1`,
      [slug],
    );

    const office = rows[0];
    if (office === undefined) return null;

    const [services, contact, related, permits] = await Promise.all([
      this.services(office.id),
      this.contact(office.id),
      this.relatedOffices(office.id),
      this.issuedPermits(office.id),
    ]);

    const detail: OfficeDetail = {
      slug: office.slug,
      name: office.name,
      category: office.category,
      shortDescription: office.shortDescription,
      aboutText: office.aboutText,
      services,
      relatedOffices: related,
      issuedPermits: permits,
    };

    // Assigned only when present. `head: undefined` still serialises the key
    // away, but writing it unconditionally invites someone to "tidy" it into
    // `head: null` later, which is the shape TAB 03 forbids.
    if (office.headName !== null && office.headPosition !== null) {
      detail.head = { name: office.headName, position: office.headPosition };
    }
    if (Object.keys(contact).length > 0) detail.contact = contact;

    return detail;
  }

  private async services(officeId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ service: string }>(
      'select service from office_services where office_id = $1 order by ordinal', [officeId]);
    return rows.map((row) => row.service);
  }

  /**
   * Confirmed contact fields only.
   *
   * 'withheld' is as excluded as 'pending', for a different reason: the owner
   * ruled that personal contacts are not published even where they are known.
   * Both produce the same wire shape, because a citizen has no business
   * inferring which of the two applies to a given office.
   */
  private async contact(officeId: string): Promise<Record<string, string>> {
    const { rows } = await this.db.query<{ field_name: string; value: string }>(
      `select c.field_name, c.value
         from office_contacts c
         join field_state fs
              on fs.entity_type = 'office' and fs.entity_id = c.office_id::text
             and fs.field_name = 'contact.' || c.field_name
        where c.office_id = $1 and fs.state = 'confirmed'`,
      [officeId],
    );
    return Object.fromEntries(rows.map((row) => [row.field_name, row.value]));
  }

  /**
   * Resolved to name plus slug so the client renders links without a second
   * call, and INNER JOINed so a relation can never come back as a slug this
   * API would 404 on.
   */
  private async relatedOffices(officeId: string): Promise<{ slug: string; name: string }[]> {
    const { rows } = await this.db.query<{ slug: string; name: string }>(
      `select r2.slug, r2.name
         from office_related r
         join offices r2 on r2.id = r.related_office_id
        where r.office_id = $1
        order by r.ordinal`,
      [officeId],
    );
    return rows;
  }

  /**
   * Derived from the permit records, never duplicated onto the office. The two
   * BFP permits have no municipal issuing office and so appear under none.
   */
  private async issuedPermits(officeId: string): Promise<{ slug: string; name: string }[]> {
    const { rows } = await this.db.query<{ slug: string; name: string }>(
      `select p.slug, p.name from permits p
        where p.issuing_office_id = $1 order by p.ordinal`,
      [officeId],
    );
    return rows;
  }
}
