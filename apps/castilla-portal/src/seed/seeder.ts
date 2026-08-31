import { ExtractedEntity, ExtractedPortalData, expressionOf, spreadsOf } from './extracted';
import { formatMagnitude } from '../municipality/magnitude';
import { provenanceFor } from './provenance';

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

/**
 * A name for the unsourced-fields report.
 *
 * `slug` and `name` are usually strings, but an entity's `name` can be a helper
 * expression (`{ __expression: 'MAYOR' }`), and template-stringifying that
 * printed `[object Object]` into the list of fields the LGU still has to
 * source. A report nobody can act on is not a report.
 */
function labelOf(entity: ExtractedEntity): string {
  for (const key of ['slug', 'name']) {
    const value = entity.fields[key];
    if (typeof value === 'string' && value.length > 0) return value;
    const expression = expressionOf(value);
    if (expression !== null) return expression;
  }
  return '?';
}

/**
 * The bundled asset a `formFile('X')` call or a checklist constant points at.
 *
 * Returns null for anything it cannot read, so an unrecognised expression
 * leaves the column NULL and the API omits the link — never a half-built path
 * that 404s on a citizen looking for a government form.
 */
function assetPath(data: ExtractedPortalData, value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('/assets/permits/') ? value : null;

  const expression = expressionOf(value);
  if (expression === null) return null;

  const direct = /^formFile\(\s*'([^']+)'\s*\)$/.exec(expression);
  if (direct !== null) return `/assets/permits/${direct[1]!}`;

  // A named constant such as BUILDING_AND_OCCUPANCY_CHECKLIST, which is itself
  // a formFile(...) call. Resolved one hop, then re-read.
  const named = resolveConstValue(data, expression);
  return named === null ? null : assetPath(data, named);
}

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
      // An appointed head written inline on the office. Until 2026-08-30 this
      // name was read to decide the head's STATE and then thrown away, so 15
      // offices were 'head: confirmed' with nothing to serve. The 005 trigger
      // now refuses that combination outright.
      let headName: string | null = null;
      let headPosition: string | null = null;
      if (headExpression === null && typeof head === 'object' && head !== null) {
        const inline = head as Record<string, unknown>;
        const name = inline['name'];
        const position = inline['position'];
        // `placeholderHead()` produces 'Name pending confirmation'. It is a
        // sentinel, not a head, and TAB 03 forbids it reaching the wire — so it
        // is refused entry to the column rather than filtered on the way out.
        if (typeof name === 'string' && name.length > 0 && inline['isPlaceholder'] !== true) {
          headName = name;
          headPosition = typeof position === 'string' && position.length > 0 ? position : null;
        }
      }

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
                              head_official_id, head_name, head_position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (slug) do update set name = excluded.name,
           category_id = excluded.category_id, short_description = excluded.short_description,
           about_text = excluded.about_text, ordinal = excluded.ordinal,
           head_official_id = excluded.head_official_id,
           head_name = excluded.head_name, head_position = excluded.head_position
         returning id`,
        [slug, o.fields['name'], o.fields['category'], o.fields['shortDescription'],
         o.fields['aboutText'], ordinal, headOfficialId,
         headOfficialId === null ? headName : null,
         headOfficialId === null ? headPosition : null],
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

    // Relations come after every office exists, because they point at each
    // other and half of them would otherwise resolve to nothing. `office_related`
    // was created in 001 and had never been written to; the table was empty
    // while every office in the source carried relatedOfficeSlugs.
    for (const o of offices) {
      const slug = String(o.fields['slug']);
      const officeId = officeIdBySlug.get(slug);
      if (officeId === undefined) continue;
      const related = (o.fields['relatedOfficeSlugs'] as unknown[] | undefined) ?? [];
      let ordinal = 0;
      for (const target of related) {
        const targetId = typeof target === 'string' ? officeIdBySlug.get(target) : undefined;
        if (targetId === undefined) {
          // A slug naming no office is a broken link on the live site, so it is
          // REPORTED rather than skipped quietly.
          unplaced.push(`${slug}: relatedOfficeSlugs names '${String(target)}', which is not an office`);
          continue;
        }
        if (targetId === officeId) {
          unplaced.push(`${slug}: relatedOfficeSlugs names itself`);
          continue;
        }
        await this.upsert(
          `insert into office_related (office_id, related_office_id, ordinal)
           values ($1,$2,$3)
           on conflict (office_id, related_office_id) do update set ordinal = excluded.ordinal
           where office_related.ordinal is distinct from excluded.ordinal`,
          [officeId, targetId, ordinal],
        );
        ordinal += 1;
      }
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

      // `formFile('X')` and the BUILDING_AND_OCCUPANCY_CHECKLIST const, both
      // resolved HERE rather than in the extractor, for the same reason every
      // other helper is: what a call means is a seeding decision, and burying
      // it in an AST walk hides it. A permit with no form keeps NULL — 5 of the
      // 19 publish none, and that is a fact about the LGU.
      // A NULL here must mean "the LGU publishes none", never "the seeder could
      // not read the expression". The two are indistinguishable in the column,
      // so the difference is caught before it gets there.
      const formUrl = assetPath(data, p.fields['formUrl']);
      const checklistUrl = assetPath(data, p.fields['checklistUrl']);
      for (const [field, raw, resolved] of [
        ['formUrl', p.fields['formUrl'], formUrl],
        ['checklistUrl', p.fields['checklistUrl'], checklistUrl],
      ] as const) {
        if (raw !== undefined && raw !== null && resolved === null) {
          unplaced.push(
            `${slug}: ${field} is ${JSON.stringify(raw)}, which this seeder could not resolve `
            + 'to a bundled asset; the link would silently not exist');
        }
      }

      await this.upsert(
        `update permits set form_url = $2, checklist_url = $3
          where id = $1 and (form_url is distinct from $2
                          or checklist_url is distinct from $3)`,
        [id, formUrl, checklistUrl],
      );
      // All 19 are unconfirmed: the requirements reflect general Philippine LGU
      // practice and have not been checked against Castilla's own charter.
      await this.state('permit', id, 'record', this.stateOf(p, 'name'), p, unsourced);
    }

    for (const [ordinal, f] of profile.entries()) {
      const label = String(f.fields['label']);
      const value = String(f.fields['value']);
      const count = f.fields['count'];

      // The count and the display value must agree, and the check belongs HERE
      // rather than in the API: a field whose number and whose words disagree
      // is bad data, and letting it into the database means every reader has to
      // decide which half to believe. The home page hardcoding 60,635 was the
      // same disagreement in a different place.
      if (typeof count === 'number') {
        const rendered = formatMagnitude({
          count,
          suffix: typeof f.fields['countSuffix'] === 'string' ? f.fields['countSuffix'] : null,
          decimals: typeof f.fields['countDecimals'] === 'number' ? f.fields['countDecimals'] : null,
        });
        if (rendered !== value) {
          throw new Error(
            `profile field '${label}': the count renders as '${rendered}' but the published `
            + `value is '${value}'. One of them is wrong and this seeder will not choose.`);
        }
      }

      const id = await this.upsertReturningId(
        `insert into profile_fields (label, value, count, count_suffix, count_decimals, ordinal)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (label) do update set value = excluded.value, count = excluded.count,
           count_suffix = excluded.count_suffix, count_decimals = excluded.count_decimals,
           ordinal = excluded.ordinal
         where profile_fields.value is distinct from excluded.value
            or profile_fields.count is distinct from excluded.count
            or profile_fields.ordinal is distinct from excluded.ordinal
         returning id`,
        [label, value, count ?? null,
         f.fields['countSuffix'] ?? null, f.fields['countDecimals'] ?? null, ordinal],
        `select id from profile_fields where label = $1`, [label],
      );

      // Profile fields carried no confirmation state at all, which left a hole
      // in the invariant every other entity obeys: 'unconfirmed content is
      // withheld' cannot hold for a field that has no state to read. The source
      // header says the demonym and a population trend were left pending until
      // a citable source was found; one has since been found, and that is a
      // fact the database should be able to express either way.
      await this.state('profile', id, 'value', this.stateOf(f, 'value'), f, unsourced);
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
    // A spread of the placeholder helper IS a placeholder contact. Treated
    // identically to the bare call: the override beside it (the Administrator's
    // published hours) is a real value, but the office's contact as a whole is
    // still something the LGU has not confirmed.
    const spreadPlaceholder = spreadsOf(contact).some((e) => e.startsWith('placeholderContact'));
    if (expressionOf(contact) !== null || spreadPlaceholder) {
      // `placeholderContact(...)`: no confirmed contact for this office.
      const overrides = spreadPlaceholder && typeof contact === 'object' && contact !== null
        ? (contact as Record<string, unknown>)
        : {};
      await this.upsert(
        `update offices set contact_is_placeholder = true
          where id = $1 and contact_is_placeholder is distinct from true`,
        [officeId],
      );
      for (const field of ['telephone', 'email', 'location', 'hours']) {
        // An override written BESIDE the spread is a deliberate real value —
        // the Administrator's published hours. It is stored so the backend can
        // reproduce what the portal shows, and left pending because the office
        // it belongs to has no confirmed contact.
        const override = overrides[field];
        if (typeof override === 'string' && override.length > 0) {
          await this.upsert(
            `insert into office_contacts (office_id, field_name, value, is_institutional)
             values ($1,$2,$3,true)
             on conflict (office_id, field_name) do update set value = excluded.value
             where office_contacts.value is distinct from excluded.value`,
            [officeId, field, override],
          );
        }
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
      const reading = provenanceFor(entity, field.replace(/^contact\./, ''));
      if (!reading.ok) {
        // Never auto-confirm. A value whose comment cannot be read into a
        // source stays pending and is REPORTED, rather than being confirmed on
        // the strength of a flag alone.
        unsourced.push({
          entity: `${entityType}:${labelOf(entity)}`,
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
/**
 * The value a named module constant holds.
 *
 * Returns it UNRESOLVED — a string for a plain constant, an `__expression` for
 * one initialised by a helper call. The caller decides how far to follow it,
 * because a constant pointing at another helper is exactly the case that was
 * silently dropping four permits' checklist links.
 */
function resolveConstValue(data: ExtractedPortalData, expression: string): unknown {
  for (const entities of Object.values(data.files)) {
    const match = entities.find((e) => e.source === expression);
    if (match !== undefined) return match.fields['value'];
  }
  return null;
}

function resolveConst(data: ExtractedPortalData, expression: string): string | null {
  const value = resolveConstValue(data, expression);
  return typeof value === 'string' ? value : null;
}
