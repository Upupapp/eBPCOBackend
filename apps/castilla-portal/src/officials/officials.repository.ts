import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

/** The four seats the municipal council actually has. */
export type OfficialRole = 'mayor' | 'vice-mayor' | 'sb-member' | 'sb-ex-officio';

export interface Official {
  slug: string;
  name: string;
  position: string;
  office: string;
  initials: string;
  /**
   * Which seat this official holds.
   *
   * The website renders four groups and could only reconstruct them by matching
   * on `position`, which is prose written for a citizen: "Sangguniang Bayan
   * Member (ABC President)" is one edit from matching nothing. The role is the
   * fact; the position is how it is worded.
   */
  role: OfficialRole;
  photoUrl?: string;
}

@Injectable()
export class OfficialsRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * The elected leadership, confirmed entries only.
   *
   * The ABC President's seat is real and currently unfilled in the record:
   * every source found names the PROVINCIAL-level president, a different
   * office, so attributing it to a real person was declined. It is withheld
   * here for the same reason an unconfirmed office head is — and, as
   * everywhere else in this API, by being ABSENT rather than by being named
   * 'Name pending confirmation'.
   */
  async list(): Promise<Official[]> {
    const { rows } = await this.db.query<{
      slug: string; name: string; position: string;
      office: string; initials: string; photo_url: string | null; role: OfficialRole;
    }>(
      `select x.slug, x.name, x.position, x.office, x.initials, x.photo_url, x.role
         from officials x
         join field_state fs
              on fs.entity_type = 'official' and fs.entity_id = x.id::text
             and fs.field_name = 'name'
        where fs.state = 'confirmed'
        order by x.ordinal`,
    );

    return rows.map((row) => {
      const official: Official = {
        slug: row.slug, name: row.name, position: row.position,
        office: row.office, initials: row.initials, role: row.role,
      };
      if (row.photo_url !== null) official.photoUrl = row.photo_url;
      return official;
    });
  }
}
