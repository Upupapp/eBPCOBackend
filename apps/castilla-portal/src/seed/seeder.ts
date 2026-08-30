import { ExtractedEntity, ExtractedPortalData, expressionOf } from './extracted';
import { commentFor, readProvenance } from './provenance';

/**
 * Importing the portal's committed data without losing a field, a source or a
 * confirmation state.
 *
 * ── What the helper calls mean, decided here and not in the extractor ────
 *
 * The extractor records `placeholderHead('Municipal Mayor')` verbatim rather
 * than resolving it, because what a helper MEANS for confirmation state is a
 * seeding decision and burying it in an extractor would hide the one judgement
 * TAB 15 warns hardest about. Those meanings are:
 *
 *   placeholderHead(...)     the LGU has not confirmed a head    -> pending
 *   headFromOfficial(X)      the head IS the official record X   -> that record's state
 *   placeholderContact(...)  no confirmed contact for this office -> pending
 *
 * ── Never auto-confirm ──────────────────────────────────────────────────
 *
 * A value is confirmed only when the source says it is unconfirmed-free AND a
 * comment cites a source that can be read into a provenance record. The schema
 * enforces the second half anyway -- `confirmed` without provenance is refused
 * by the database -- so a seeder that tried to cut the corner would fail loudly
 * rather than quietly. Belt and braces, deliberately.
 */

export interface Sql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Reconciliation {
  readonly portalCommit: string;
  readonly counts: Record<string, number>;
  readonly confirmed: Record<string, number>;
  readonly pending: Record<string, number>;
  /** Facts whose comment could not be read into provenance, with the reason. */
  readonly unsourced: ReadonlyArray<{ entity: string; field: string; reason: string }>;
  /** Anything in the source this seeder could not place at all. */
  readonly unplaced: readonly string[];
  readonly writes: number;
}

const OFFICE = 'office';

export class Seeder {
  private writes = 0;

  constructor(private readonly db: Sql) {}

  async run(data: ExtractedPortalData): Promise<Reconciliation> {
    this.writes = 0;
    const unsourced: { entity: string; field: string; reason: string }[] = [];
    const unplaced: string[] = [];

    const offices = this.of(data, 'offices.data.ts', 'MUNICIPAL_OFFICES');
    const categories = this.of(data, 'offices.data.ts', 'OFFICE_CATEGORIES');
    const officials = [
      ...this.of(data, 'officials.data.ts', 'MAYOR'),
      ...this.of(data, 'officials.data.ts', 'VICE_MAYOR'),
      ...this.of(data, 'officials.data.ts', 'SB_MEMBERS'),
      ...this.of(data, 'officials.data.ts', 'SB_EXOFFICIO_MEMBERS'),
    ];
    const permits = this.of(data, 'permits.data.ts', 'PUBLIC_PERMIT_TYPES');
    const permitGroups = this.of(data, 'permits.data.ts', 'PERMIT_OFFICE_GROUPS');
    const profile = this.of(data, 'municipality.data.ts', 'PROFILE_FIELDS');

    for (const [ordinal, c] of categories.entries()) {
      await this.upsert(
        `insert into office_categories (id, label, ordinal) values ($1,$2,$3)
         on conflict (id) do update set label = excluded.label, ordinal = excluded.ordinal
         where office_categories.label is distinct from excluded.label
            or office_categories.ordinal is distinct from excluded.ordinal`,
        [c.fields['id'], c.fields['label'], ordinal],
      );
    }

    for (const [ordinal, g] of permitGroups.entries()) {
      await this.upsert(
        `insert into permit_office_groups (id, label, ordinal) values ($1,$2,$3)
         on conflict (id) do update set label = excluded.label, ordinal = excluded.ordinal
         where permit_office_groups.label is distinct from excluded.label
            or permit_office_groups.ordinal is distinct from excluded.ordinal`,
        [g.fields['id'], g.fields['label'], ordinal],
      );
    }

    // Officials before offices: two office heads ARE official records, and one
    // fact in one row is the point.
    const officialIdBySlug = new Map<string, string>();
    for (const [ordinal, o] of officials.entries()) {
      const name = String(o.fields['name']);
      const slug = slugify(name);
      const id = await this.upsertReturningId(
        `insert into officials (slug, name, position, office, initials, photo_url, ordinal)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (slug) do update set name = excluded.name, position = excluded.position,
           office = excluded.office, initials = excluded.initials,
           photo_url = excluded.photo_url, ordinal = excluded.ordinal
         returning id`,
        [slug, name, o.fields['position'], o.fields['office'], o.fields['initials'],
         o.fields['photoUrl'] ?? null, ordinal],
        `select id from officials where slug = $1`, [slug],
      );
      officialIdBySlug.set(slug, id);
      await this.state(officials_(o), id, 'name', this.stateOf(o, 'name'), o, unsourced);
    }

    const officeIdBySlug = new Map<string, string>();
    for (const [ordinal, o] of offices.entries()) {
      const slug = String(o.fields['slug']);
      const head = o.fields['head'];
      const headExpression = expressionOf(head);
      let headOfficialId: string | null = null;

      if (headExpression?.startsWith('headFromOfficial') === true) {
        // `headFromOfficial(MAYOR)` -- the head IS that official's record.
        const which = /headFromOfficial\((\w+)\)/.exec(headExpression)?.[1];
        const named = officials.find((x) => x.source === which);
        if (named === undefined) {
          unplaced.push(`${slug}: head derives from ${which ?? '?'}, which was not extracted`);
        } else {
          headOfficialId = officialIdBySlug.get(slugify(String(named.fields['name']))) ?? null;
        }
      }

      const id = await this.upsertReturningId(
        `insert into offices (slug, name, category_id, short_description, about_text, ordinal,
                              head_official_id)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (slug) do update set name = excluded.name,
           category_id = excluded.category_id, short_description = excluded.short_description,
           about_text = excluded.about_text, ordinal = excluded.ordinal,
           head_official_id = excluded.head_official_id
         returning id`,
        [slug, o.fields['name'], o.fields['category'], o.fields['shortDescription'],
         o.fields['aboutText'], ordinal, headOfficialId],
        `select id from offices where slug = $1`, [slug],
      );
      officeIdBySlug.set(slug, id);

      await this.replaceOrdered(
        'office_services', 'office_id', id, 'service',
        (o.fields['services'] as unknown[] | undefined) ?? [],
      );

      // The head's confirmation state.
      //
      //   placeholderHead(...)  the LGU has not confirmed one     -> pending
      //   headFromOfficial(X)   inherits X's state, which is confirmed
      //   an inline object      confirmed when it cites a source
      const derivedFrom = headExpression?.startsWith('headFromOfficial') === true
        ? officials.find((x) => x.source === /headFromOfficial\((\w+)\)/.exec(headExpression)?.[1])
        : undefined;
      const headState = headExpression?.startsWith('placeholderHead') === true
        ? 'pending'
        : this.stateOf(o, 'head');
      // A head derived from an official inherits THAT record's source, not the
      // office's. One fact in one row means one provenance too -- asking the
      // office why it names the Mayor would find nothing, because the office
      // does not know: the officials file does.
      await this.state(OFFICE, id, 'head', headState, derivedFrom ?? o, unsourced);

      await this.contacts(id, o, unsourced);
    }

    for (const [ordinal, p] of permits.entries()) {
      const slug = String(p.fields['slug']);
      const officeSlugExpr = expressionOf(p.fields['issuingOfficeSlug']);
      // `null` is a FACT here, not a gap: the two BFP permits are issued by a
      // national agency with no municipal office record.
      const officeSlug = officeSlugExpr === null
        ? (p.fields['issuingOfficeSlug'] as string | null)
        : resolveConst(data, officeSlugExpr);
      const id = await this.upsertReturningId(
        `insert into permits (slug, name, office_group_id, issuing_office_id,
                              issuing_office_name, description, validity, process_note, ordinal)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (slug) do update set name = excluded.name,
           office_group_id = excluded.office_group_id,
           issuing_office_id = excluded.issuing_office_id,
           issuing_office_name = excluded.issuing_office_name,
           description = excluded.description, validity = excluded.validity,
           process_note = excluded.process_note, ordinal = excluded.ordinal
         returning id`,
        [slug, p.fields['name'], p.fields['officeGroup'],
         officeSlug === null ? null : officeIdBySlug.get(officeSlug) ?? null,
         expressionOf(p.fields['issuingOfficeName']) === null
           ? p.fields['issuingOfficeName']
           : resolveConst(data, expressionOf(p.fields['issuingOfficeName'])!),
         p.fields['description'], p.fields['validity'], p.fields['processNote'] ?? null, ordinal],
        `select id from permits where slug = $1`, [slug],
      );

      await this.replaceOrdered(
        'permit_requirements', 'permit_id', id, 'requirement',
        (p.fields['requirements'] as unknown[] | undefined) ?? [],
      );
      // All 19 are unconfirmed: the requirements reflect general Philippine LGU
      // practice and have not been checked against Castilla's own charter.
      await this.state('permit', id, 'record', this.stateOf(p, 'name'), p, unsourced);
    }

    for (const [ordinal, f] of profile.entries()) {
      await this.upsert(
        `insert into profile_fields (label, value, count, count_suffix, count_decimals, ordinal)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (label) do update set value = excluded.value, count = excluded.count,
           count_suffix = excluded.count_suffix, count_decimals = excluded.count_decimals,
           ordinal = excluded.ordinal
         where profile_fields.value is distinct from excluded.value
            or profile_fields.count is distinct from excluded.count
            or profile_fields.ordinal is distinct from excluded.ordinal`,
        [f.fields['label'], f.fields['value'], f.fields['count'] ?? null,
         f.fields['countSuffix'] ?? null, f.fields['countDecimals'] ?? null, ordinal],
      );
    }

    return {
      portalCommit: data.commit,
      counts: {
        offices: offices.length, officeCategories: categories.length,
        officials: officials.length, permits: permits.length,
        permitGroups: permitGroups.length, profileFields: profile.length,
      },
      confirmed: await this.countBy('confirmed'),
      pending: await this.countBy('pending'),
      unsourced, unplaced, writes: this.writes,
    };
  }

  private of(data: ExtractedPortalData, file: string, constant: string): ExtractedEntity[] {
    return (data.files[file] ?? []).filter((e) => e.source === constant);
  }

  /** `isPlaceholder: true` is the source saying the LGU has not confirmed it. */
  private stateOf(entity: ExtractedEntity, field: string): 'confirmed' | 'pending' {
    const nested = entity.fields[field];
    const flag = typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)['isPlaceholder']
      : entity.fields['isPlaceholder'];
    return flag === true ? 'pending' : 'confirmed';
  }

  private async contacts(
    officeId: string, office: ExtractedEntity,
    unsourced: { entity: string; field: string; reason: string }[],
  ): Promise<void> {
    const contact = office.fields['contact'];
    if (expressionOf(contact) !== null) {
      // `placeholderContact(...)`: no confirmed contact for this office.
      for (const field of ['telephone', 'email', 'location', 'hours']) {
        await this.state(OFFICE, officeId, `contact.${field}`, 'pending', office, unsourced);
      }
      return;
    }
    if (typeof contact !== 'object' || contact === null) return;

    const values = contact as Record<string, unknown>;
    for (const field of ['telephone', 'email', 'location', 'hours']) {
      const value = values[field];
      if (typeof value !== 'string' || value.length === 0) {
        // Absent is absent. The field is pending and nothing is stored, which
        // is the whole point of the front end having dropped the
        // 'Pending confirmation' sentinel.
        await this.state(OFFICE, officeId, `contact.${field}`, 'pending', office, unsourced);
        continue;
      }
      // Institutional unless the value is plainly a person's mailbox. The
      // owner's ruling withholds personal contacts, and this is the column that
      // makes the ruling decidable.
      const institutional = !/@gmail\.|@yahoo\.|@hotmail\./i.test(value);
      await this.upsert(
        `insert into office_contacts (office_id, field_name, value, is_institutional)
         values ($1,$2,$3,$4)
         on conflict (office_id, field_name) do update set value = excluded.value,
           is_institutional = excluded.is_institutional
         where office_contacts.value is distinct from excluded.value
            or office_contacts.is_institutional is distinct from excluded.is_institutional`,
        [officeId, field, value, institutional],
      );
      const state = values['isPlaceholder'] === true
        ? 'pending'
        : institutional ? 'confirmed' : 'withheld';
      await this.state(OFFICE, officeId, `contact.${field}`, state, office, unsourced);
    }
  }

  private async state(
    entityType: string, entityId: string, field: string,
    want: 'confirmed' | 'pending' | 'withheld', entity: ExtractedEntity,
    unsourced: { entity: string; field: string; reason: string }[],
  ): Promise<void> {
    let state = want;

    if (want === 'confirmed') {
      const reading = readProvenance(commentFor(entity, field.replace(/^contact\./, '')));
      if (!reading.ok) {
        // Never auto-confirm. A value whose comment cannot be read into a
        // source stays pending and is REPORTED, rather than being confirmed on
        // the strength of a flag alone.
        unsourced.push({
          entity: `${entityType}:${String(entity.fields['slug'] ?? entity.fields['name'] ?? '?')}`,
          field, reason: reading.reason,
        });
        state = 'pending';
      } else {
        await this.upsert(
          `insert into provenance (entity_type, entity_id, field_name, source_description,
                                   sourced_on, method)
           select $1,$2,$3,$4,$5::date,$6::provenance_method
            where not exists (
              select 1 from provenance where entity_type = $1 and entity_id = $2
                and field_name = $3 and source_description = $4)`,
          [entityType, entityId, field, reading.provenance.sourceDescription,
           reading.provenance.sourcedOn, reading.provenance.method],
        );
      }
    }

    await this.upsert(
      `insert into field_state (entity_type, entity_id, field_name, state)
       values ($1,$2,$3,$4::confirmation_state)
       on conflict (entity_type, entity_id, field_name) do update set state = excluded.state
       where field_state.state is distinct from excluded.state`,
      [entityType, entityId, field, state],
    );
  }

  private async replaceOrdered(
    table: string, fk: string, id: string, column: string, values: unknown[],
  ): Promise<void> {
    // Order is meaningful, so position is the key. Rewritten only when it
    // differs, so a re-run writes nothing.
    const existing = await this.db.query<{ ordinal: number; v: string }>(
      `select ordinal, ${column} as v from ${table} where ${fk} = $1 order by ordinal`, [id],
    );
    const same = existing.rows.length === values.length
      && existing.rows.every((row, i) => row.v === String(values[i]));
    if (same) return;

    await this.db.query(`delete from ${table} where ${fk} = $1`, [id]);
    for (const [ordinal, value] of values.entries()) {
      await this.db.query(
        `insert into ${table} (${fk}, ordinal, ${column}) values ($1,$2,$3)`,
        [id, ordinal, String(value)],
      );
    }
    this.writes += 1;
  }

  /**
   * Runs a conditional upsert and counts it only if a row actually changed.
   *
   * `returning 1` is what makes that countable: an `on conflict do update ...
   * where` whose predicate is false writes nothing and returns nothing. Reading
   * a driver's `affectedRows` instead was the first attempt and reported fifty
   * writes on an unchanged re-run -- a number that looks like work and is not.
   */
  private async upsert(sql: string, params: unknown[]): Promise<void> {
    const result = await this.db.query<{ one: number }>(`${sql} returning 1 as one`, params);
    if (result.rows.length > 0) this.writes += 1;
  }

  private async upsertReturningId(
    sql: string, params: unknown[], fallback: string, fallbackParams: unknown[],
  ): Promise<string> {
    // The entity upserts always return an id, so a returned row does not by
    // itself mean anything changed. The existence check runs first and decides.
    const before = await this.db.query<{ id: string }>(fallback, fallbackParams);
    const result = await this.db.query<{ id: string }>(sql, params);
    const id = result.rows[0]?.id;
    if (before.rows.length === 0) this.writes += 1;
    if (id !== undefined) return id;
    const existing = await this.db.query<{ id: string }>(fallback, fallbackParams);
    return existing.rows[0]!.id;
  }

  private async countBy(state: string): Promise<Record<string, number>> {
    const rows = await this.db.query<{ entity_type: string; field_name: string; n: number }>(
      `select entity_type, field_name, count(*)::int as n from field_state
        where state = $1 group by entity_type, field_name`, [state],
    );
    const out: Record<string, number> = {};
    for (const row of rows.rows) out[`${row.entity_type}.${row.field_name}`] = row.n;
    return out;
  }
}

function officials_(_: ExtractedEntity): string { return 'official'; }

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** `OBO_OFFICE_SLUG` and friends are module constants the extractor recorded. */
function resolveConst(data: ExtractedPortalData, expression: string): string | null {
  for (const entities of Object.values(data.files)) {
    const match = entities.find((e) => e.source === expression);
    if (match !== undefined) {
      const value = match.fields['value'];
      if (typeof value === 'string') return value;
    }
  }
  return null;
}
