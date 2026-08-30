import {
  municipalityProfileSchema, officialListSchema, officeDetailSchema,
} from '../src/http/contract';
import { formatMagnitude } from '../src/municipality/magnitude';
import { Harness, harness } from './http-harness';

/** TAB 04 — officials and the municipality profile. */

let api: Harness;

beforeAll(async () => { api = await harness(); }, 120000);
afterAll(async () => { await api.close(); });

const profile = async () => {
  const { status, body } = await api.get('/municipality/profile');
  expect(status).toBe(200);
  return municipalityProfileSchema.parse(body).fields;
};

const officials = async () => {
  const { status, body } = await api.get('/officials');
  expect(status).toBe(200);
  return officialListSchema.parse(body).officials;
};

describe('GET /municipality/profile', () => {
  it('serves all 11 fields in the municipality’s own order', async () => {
    const fields = await profile();

    expect(fields).toHaveLength(11);
    expect(fields[0]?.label).toBe('Province');
  });

  it('carries a count for the three genuine magnitudes', async () => {
    const withCount = (await profile()).filter((f) => f.count !== undefined);

    expect(withCount.map((f) => f.label))
      .toEqual(['Number of Barangays', 'Population', 'Land Area']);
  });

  it('gives identifiers no count at all', async () => {
    // Counting up to a postal code is meaningless and the front end
    // deliberately does not. Handing it a number is an invitation to.
    const fields = await profile();

    for (const label of ['ZIP Code', 'PSGC Code', 'Founding / Establishment']) {
      const field = fields.find((f) => f.label === label);
      expect(field).toBeDefined();
      expect(field?.count).toBeUndefined();
    }
  });

  it('renders every count back to its published value exactly', async () => {
    // TAB 04's named criterion. Consistency is the API's guarantee, not the
    // client's: population 60,635 with suffix (2020 Census) must read the same
    // whether the client animates the count or prints the value.
    const fields = await profile();
    const magnitudes = fields.filter((f) => f.count !== undefined);
    expect(magnitudes).toHaveLength(3);

    for (const field of magnitudes) {
      expect(formatMagnitude({
        count: field.count!,
        suffix: field.countSuffix ?? null,
        decimals: field.countDecimals ?? null,
      })).toBe(field.value);
    }
  });

  it('changes every figure when a different municipality is substituted', async () => {
    // The criterion that proves nothing is hardcoded downstream. Rewriting the
    // stored profile must move every rendered number and string; anything that
    // survives is a value the API is not actually reading from the data.
    const before = await profile();

    await api.db.query(
      `update profile_fields set value = '99,999 (2099 Census)', count = 99999,
              count_suffix = '(2099 Census)'
        where label = 'Population'`);
    await api.db.query(
      `update profile_fields set value = '1.00 km²', count = 1, count_suffix = 'km²',
              count_decimals = 2 where label = 'Land Area'`);
    await api.db.query(
      "update profile_fields set value = 'Elsewhere' where label = 'Province'");

    const after = await profile();
    const figure = (fields: typeof before, label: string) =>
      fields.find((f) => f.label === label);

    expect(figure(after, 'Population')?.value).toBe('99,999 (2099 Census)');
    expect(figure(after, 'Population')?.count).toBe(99999);
    expect(figure(after, 'Land Area')?.value).toBe('1.00 km²');
    expect(figure(after, 'Province')?.value).toBe('Elsewhere');
    for (const label of ['Population', 'Land Area', 'Province']) {
      expect(figure(after, label)?.value).not.toBe(figure(before, label)?.value);
    }

    // Restored, because this harness is shared across the file.
    await api.db.query(
      `update profile_fields set value = '60,635 (2020 Census)', count = 60635,
              count_suffix = '(2020 Census)' where label = 'Population'`);
    await api.db.query(
      `update profile_fields set value = '186.20 km²', count = 186.2, count_suffix = 'km²',
              count_decimals = 2 where label = 'Land Area'`);
    await api.db.query(
      "update profile_fields set value = 'Sorsogon' where label = 'Province'");
  });

  it('withholds a profile field whose state is pending', async () => {
    // Every one of the 11 is confirmed today, so removing the state filter
    // entirely would not change a single assertion above — the rule would be
    // untested and would leak the moment the LGU marked something pending.
    // The source header says the demonym and a population trend were left
    // pending until a citable source was found, so this state is real.
    await api.db.query(
      `update field_state set state = 'pending'
        where entity_type = 'profile' and entity_id in
              (select id::text from profile_fields where label = 'Demonym')`);

    const fields = await profile();

    expect(fields).toHaveLength(10);
    expect(fields.map((f) => f.label)).not.toContain('Demonym');
    expect(JSON.stringify(fields)).not.toContain('Castillano');

    await api.db.query(
      `update field_state set state = 'confirmed'
        where entity_type = 'profile' and entity_id in
              (select id::text from profile_fields where label = 'Demonym')`);
  });

  it('refuses to serve a count that disagrees with its published value', async () => {
    // Bad data edited straight into the database. The API would rather fail
    // than hand a citizen a number and a label that contradict each other.
    await api.db.query("update profile_fields set count = 12345 where label = 'Population'");

    const { status } = await api.get('/municipality/profile');
    expect(status).toBe(500);

    await api.db.query("update profile_fields set count = 60635 where label = 'Population'");
    expect((await api.get('/municipality/profile')).status).toBe(200);
  });
});

describe('GET /officials', () => {
  it('serves the 11 confirmed seats', async () => {
    const list = await officials();

    expect(list).toHaveLength(11);
    expect(list[0]?.position).toBe('Municipal Mayor');
  });

  it('withholds the unconfirmed ABC President seat', async () => {
    // TAB 04's named criterion. Absent, never 'Name pending confirmation'.
    const list = await officials();

    expect(list.map((o) => o.position)).not.toContain('ABC President (Liga ng mga Barangay)');
    expect(JSON.stringify(list).toLowerCase()).not.toContain('pending confirmation');
  });

  it('serves the SK Federation President', async () => {
    // The other half: the criterion above passes equally against an endpoint
    // that withholds both ex-officio seats.
    const list = await officials();

    expect(list.some((o) => o.position.includes('SK Federation'))).toBe(true);
  });

  it('serves the 8 Sangguniang Bayan members', async () => {
    // These were ALL reported unsourced until 2026-08-30: a naming note above
    // `export const SB_MEMBERS` shadowed the file header that sources them.
    const list = await officials();

    expect(list.filter((o) => o.office === 'Sangguniang Bayan'
      && !o.position.includes('SK Federation'))).toHaveLength(8);
  });

  it('omits photoUrl rather than sending null', async () => {
    const list = await officials();

    for (const official of list) {
      if ('photoUrl' in official) expect(official.photoUrl).toBeTruthy();
    }
  });
});

describe('one fact, one row', () => {
  it('names the same Mayor on /officials and on his office, from one row', async () => {
    // TAB 04's named criterion, and a real defect on the live site: the portal
    // named the Mayor on /local-government while showing his office as
    // headless on /offices.
    const { body } = await api.get('/offices/office-of-the-mayor');
    const office = officeDetailSchema.parse(body);
    const mayor = (await officials()).find((o) => o.position === 'Municipal Mayor');

    expect(office.head?.name).toBe(mayor?.name);
    expect(office.head?.position).toBe(mayor?.position);
  });

  it('proves it is literally one row, not two that agree today', async () => {
    // Equal strings would also be produced by two rows someone kept in sync by
    // hand. The office must point AT the official's row.
    const linked = await api.db.query<{ n: number }>(
      `select count(*)::int as n
         from offices o
         join officials x on x.id = o.head_official_id
        where o.slug = 'office-of-the-mayor' and x.position = 'Municipal Mayor'`);

    expect(linked.rows[0]!.n).toBe(1);
  });

  it('moves both surfaces when the single row changes', async () => {
    // The strongest form: edit the one row and watch both endpoints follow.
    await api.db.query(
      "update officials set name = 'A Different Mayor' where position = 'Municipal Mayor'");

    const office = officeDetailSchema.parse((await api.get('/offices/office-of-the-mayor')).body);
    const mayor = (await officials()).find((o) => o.position === 'Municipal Mayor');

    expect(office.head?.name).toBe('A Different Mayor');
    expect(mayor?.name).toBe('A Different Mayor');

    await api.db.query(
      `update officials set name = 'Isagani "Bong" B. Mendoza' where position = 'Municipal Mayor'`);
  });
});
