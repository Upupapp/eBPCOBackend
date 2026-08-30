import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';
import { Magnitude, formatMagnitude } from './magnitude';

export interface ProfileField {
  label: string;
  value: string;
  count?: number;
  countSuffix?: string;
  countDecimals?: number;
}

@Injectable()
export class MunicipalityRepository {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  /**
   * The 11-field profile, in the municipality's own order.
   *
   * `count` is present only where the field is a genuine magnitude. A ZIP code
   * and a PSGC code are identifiers: counting up to a postal code is
   * meaningless, and the front end deliberately does not — so the API must not
   * hand it a number that invites it to.
   */
  async profile(): Promise<ProfileField[]> {
    const { rows } = await this.db.query<{
      label: string; value: string;
      count: string | null; count_suffix: string | null; count_decimals: number | null;
    }>(
      `select p.label, p.value, p.count, p.count_suffix, p.count_decimals
         from profile_fields p
         join field_state fs
              on fs.entity_type = 'profile' and fs.entity_id = p.id::text
             and fs.field_name = 'value'
        where fs.state = 'confirmed'
        order by p.ordinal`,
    );

    return rows.map((row) => {
      const field: ProfileField = { label: row.label, value: row.value };
      if (row.count === null) return field;

      // Postgres returns `numeric` as a string to protect precision. Number()
      // here rather than in the driver config, so the widening is visible at
      // the one place it happens.
      const magnitude: Magnitude = {
        count: Number(row.count),
        suffix: row.count_suffix,
        decimals: row.count_decimals,
      };

      // The consistency the seeder already refuses to violate, re-asserted on
      // the way out. It costs one string compare per magnitude and it means a
      // value edited directly in the database cannot reach a citizen as a
      // number and a label that disagree.
      if (formatMagnitude(magnitude) !== row.value) {
        throw new Error(
          `profile field '${row.label}' has a count that does not render to its published value`);
      }

      field.count = magnitude.count;
      if (row.count_suffix !== null) field.countSuffix = row.count_suffix;
      if (row.count_decimals !== null) field.countDecimals = row.count_decimals;
      return field;
    });
  }
}
