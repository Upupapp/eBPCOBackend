import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface PermitSummary {
  slug: string;
  name: string;
  description: string;
  confirmationState: 'pending' | 'confirmed';
}

export interface PermitGroup {
  id: string;
  label: string;
  permits: PermitSummary[];
}

export interface PermitDetail extends PermitSummary {
  group: { id: string; label: string };
  issuingOffice: { name: string; slug?: string };
  requirements: string[];
  validity: string;
  processNote?: string;
  formUrl?: string;
  checklistUrl?: string;
}

@Injectable()
export class PermitsRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * The catalogue, grouped and in the published order.
   *
   * Unlike offices and officials, an unconfirmed permit is SERVED, with its
   * state attached. All 19 are unconfirmed today — the requirements reflect
   * general Philippine LGU practice and have not been checked against
   * Castilla's own citizen's charter — so withholding on the same rule would
   * publish an empty catalogue and tell a citizen the LGU issues no permits.
   * That is a worse lie than an honest 'not yet verified'. The state travels
   * with the record so the client can say so.
   */
  async catalogue(): Promise<PermitGroup[]> {
    const { rows } = await this.db.query<{
      group_id: string; group_label: string;
      slug: string; name: string; description: string; state: string;
    }>(
      `select g.id as group_id, g.label as group_label,
              p.slug, p.name, p.description, fs.state::text as state
         from permits p
         join permit_office_groups g on g.id = p.office_group_id
         join field_state fs
              on fs.entity_type = 'permit' and fs.entity_id = p.id::text
             and fs.field_name = 'record'
        order by g.ordinal, p.ordinal`,
    );

    const groups: PermitGroup[] = [];
    for (const row of rows) {
      let group = groups.find((g) => g.id === row.group_id);
      if (group === undefined) {
        group = { id: row.group_id, label: row.group_label, permits: [] };
        groups.push(group);
      }
      group.permits.push({
        slug: row.slug, name: row.name, description: row.description,
        confirmationState: row.state === 'confirmed' ? 'confirmed' : 'pending',
      });
    }
    return groups;
  }

  async detail(slug: string): Promise<PermitDetail | null> {
    const { rows } = await this.db.query<{
      id: string; slug: string; name: string; description: string; state: string;
      group_id: string; group_label: string;
      issuing_office_name: string; issuing_office_slug: string | null;
      validity: string; process_note: string | null;
      form_url: string | null; checklist_url: string | null;
    }>(
      `select p.id, p.slug, p.name, p.description, fs.state::text as state,
              g.id as group_id, g.label as group_label,
              p.issuing_office_name, o.slug as issuing_office_slug,
              p.validity, p.process_note, p.form_url, p.checklist_url
         from permits p
         join permit_office_groups g on g.id = p.office_group_id
         join field_state fs
              on fs.entity_type = 'permit' and fs.entity_id = p.id::text
             and fs.field_name = 'record'
         -- LEFT, because the two BFP permits are issued by a national agency
         -- with no municipal office row. Inventing one to make this join inner
         -- would put the Bureau of Fire Protection in the municipality's own
         -- office directory.
         left join offices o on o.id = p.issuing_office_id
        where p.slug = $1`,
      [slug],
    );

    const permit = rows[0];
    if (permit === undefined) return null;

    const { rows: requirements } = await this.db.query<{ requirement: string }>(
      'select requirement from permit_requirements where permit_id = $1 order by ordinal',
      [permit.id],
    );

    const detail: PermitDetail = {
      slug: permit.slug,
      name: permit.name,
      description: permit.description,
      confirmationState: permit.state === 'confirmed' ? 'confirmed' : 'pending',
      group: { id: permit.group_id, label: permit.group_label },
      issuingOffice: { name: permit.issuing_office_name },
      requirements: requirements.map((row) => row.requirement),
      validity: permit.validity,
    };

    // A slug only where a municipal office actually issues it, so a client
    // never builds a link to /offices/{slug} that would 404.
    if (permit.issuing_office_slug !== null) {
      detail.issuingOffice.slug = permit.issuing_office_slug;
    }
    if (permit.process_note !== null) detail.processNote = permit.process_note;
    // Absent, not null: 5 of the 19 publish no form, and the client must render
    // without a download link rather than with a broken one.
    if (permit.form_url !== null) detail.formUrl = permit.form_url;
    if (permit.checklist_url !== null) detail.checklistUrl = permit.checklist_url;

    return detail;
  }
}
