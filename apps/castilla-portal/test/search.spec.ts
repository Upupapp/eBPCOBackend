import { SearchIndexer } from '../src/search/search-indexer';
import { SearchRepository } from '../src/search/search.repository';
import { Harness, harness } from './http-harness';

/** TAB 08 — search, and the four dead terms it exists to fix. */

let api: Harness;
let search: SearchRepository;

beforeAll(async () => {
  api = await harness();
  await new SearchIndexer(api.db).rebuild();
  search = new SearchRepository(api.db);
}, 180000);

afterAll(async () => { await api.close(); });

const find = async (term: string) => search.search({ term, limit: 50 });
const titles = async (term: string) => (await find(term)).map((r) => r.title);

describe('the four terms that are dead in production', () => {
  // Each of these returns the empty state on the live site today, while the
  // office that issues the permit lists it one field away.
  it.each([
    ['building permit'],
    ['building'],
    ['occupancy'],
    ['demolition'],
    ['fencing'],
  ])('searching %p returns the Municipal Engineering Office', async (term) => {
    expect(await titles(term)).toContain('Municipal Engineering Office');
  });

  it("returns the Planning Office for 'zoning', which never says 'zoning'", async () => {
    // The harder half. This office contains the word in NONE of its own fields;
    // it is found because it issues the Zoning / Locational Clearance, and the
    // index reaches across that relationship.
    const office = await api.db.query<{ n: number }>(
      `select count(*)::int as n from offices
        where slug = 'municipal-planning-development'
          and (name ilike '%zoning%' or short_description ilike '%zoning%'
               or about_text ilike '%zoning%')`);
    expect(office.rows[0]!.n).toBe(0);

    expect(await titles('zoning'))
      .toContain('Municipal Planning and Development Office');
  });
});

describe('every permit finds its issuing office', () => {
  it('returns the stated issuing office for all 17 municipal permits', async () => {
    // TAB 08's criterion, swept rather than spot-checked. The two BFP permits
    // have no municipal issuing office, so they are excluded by the query
    // itself rather than by a hand-written exception list.
    const permits = await api.db.query<{ name: string; office: string }>(
      `select p.name, o.name as office from permits p
         join offices o on o.id = p.issuing_office_id order by p.ordinal`);
    expect(permits.rows.length).toBe(17);

    for (const permit of permits.rows) {
      expect(await titles(permit.name)).toContain(permit.office);
    }
  });

  it('finds the two BFP permits by their issuing body', async () => {
    // No municipal office issues them, and merging them into one for tidiness
    // is forbidden — so the body's own name has to be searchable.
    const results = await find('Bureau of Fire Protection');
    const slugs = results.filter((r) => r.entityType === 'permit').map((r) => r.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      'fsec-building-permit', 'fsic-occupancy-permit',
    ]));
  });
});

describe('search is not a side channel around the publication gate', () => {
  it('does not return an office by its unconfirmed contact value', async () => {
    // TAB 08's criterion. An index containing a withheld number is a way to
    // READ it: type the number, see whose office comes back.
    const secret = '0917-555-0142';
    await api.db.query(
      `insert into office_contacts (office_id, field_name, value, is_institutional)
       select o.id, 'telephone', $1, false from offices o where o.slug = 'municipal-treasurer'
       on conflict (office_id, field_name) do update set value = excluded.value`, [secret]);
    // Left pending, exactly as the seeder leaves every contact today.
    await new SearchIndexer(api.db).rebuild();

    expect(await find(secret)).toHaveLength(0);
  });

  it('returns it once it is confirmed, and only then', async () => {
    // The other half: without it, the test above passes against an indexer that
    // indexes no contacts at all.
    const secret = '0917-555-0142';
    await api.db.query(
      `insert into provenance (entity_type, entity_id, field_name, source_description,
                               sourced_on, method)
       select 'office', o.id::text, 'contact.telephone',
              'the LGU Citizen''s Charter, page 12, read at the counter',
              date '2026-08-31', 'official-document'
         from offices o where o.slug = 'municipal-treasurer'`);
    await api.db.query(
      `update field_state set state = 'confirmed'
        where field_name = 'contact.telephone'
          and entity_id in (select id::text from offices where slug = 'municipal-treasurer')`);
    await new SearchIndexer(api.db).rebuild();

    expect(await titles(secret)).toContain("Municipal Treasurer's Office");

    await api.db.query(
      `update field_state set state = 'pending'
        where field_name = 'contact.telephone'
          and entity_id in (select id::text from offices where slug = 'municipal-treasurer')`);
    await api.db.query(
      "delete from office_contacts where value = $1", [secret]);
    await new SearchIndexer(api.db).rebuild();
  });

  it('does not return an office by an unconfirmed head name', async () => {
    const pending = await api.db.query<{ slug: string }>(
      `select o.slug from offices o join field_state fs
              on fs.entity_id = o.id::text and fs.field_name = 'head'
        where fs.state = 'pending' limit 1`);
    const slug = pending.rows[0]!.slug;
    await api.db.query(
      `update offices set head_name = 'Quirino Undisclosed', head_position = 'Officer-in-Charge'
        where slug = $1`, [slug]);
    await new SearchIndexer(api.db).rebuild();

    expect(await find('Quirino Undisclosed')).toHaveLength(0);

    await api.db.query(
      'update offices set head_name = null, head_position = null where slug = $1', [slug]);
    await new SearchIndexer(api.db).rebuild();
  });
});

describe('results carry enough to render a row', () => {
  it('types every result and gives it a slug and a summary', async () => {
    const results = await find('permit');

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(['office', 'permit']).toContain(result.entityType);
      expect(result.slug).not.toBe('');
      expect(result.summary).not.toBe('');
    }
  });

  it('routes each result to a detail page that exists', async () => {
    // A typed result whose slug 404s is worse than no result.
    for (const result of (await find('building')).slice(0, 6)) {
      const path = result.entityType === 'office'
        ? `/offices/${result.slug}` : `/permits/${result.slug}`;
      expect((await api.get(path)).status).toBe(200);
    }
  });
});

describe('filters compose with the term', () => {
  it('restricts to one entity type', async () => {
    const results = await search.search({ term: 'permit', entityType: 'permit', limit: 50 });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.entityType).toBe('permit');
  });

  it('restricts to one office category, alongside a term', async () => {
    const all = await search.search({ term: 'office', entityType: 'office', limit: 50 });
    const finance = await search.search({
      term: 'office', entityType: 'office', facet: 'finance', limit: 50 });

    expect(finance.length).toBeGreaterThan(0);
    expect(finance.length).toBeLessThan(all.length);
    for (const result of finance) expect(result.facet).toBe('finance');
  });

  it('restricts to one permit group', async () => {
    const results = await search.search({ entityType: 'permit', facet: 'bfp', limit: 50 });

    expect(results.map((r) => r.slug).sort())
      .toEqual(['fsec-building-permit', 'fsic-occupancy-permit']);
  });

  it('browses a facet with no term at all', async () => {
    const results = await search.search({ entityType: 'office', facet: 'finance', limit: 50 });

    expect(results.length).toBeGreaterThan(0);
  });
});

describe('the HTTP surface', () => {
  it('answers a query', async () => {
    const { status, body } = await api.get('/search?q=zoning');

    expect(status).toBe(200);
    const results = (body as { results: { title: string }[] }).results;
    expect(results.map((r) => r.title))
      .toContain('Municipal Planning and Development Office');
  });

  it('refuses a bare /search rather than returning the whole catalogue', async () => {
    // Everything-looks-like-it-worked is the failure mode here.
    expect((await api.get('/search')).status).toBe(400);
  });

  it('refuses an unknown type', async () => {
    expect((await api.get('/search?q=permit&type=official')).status).toBe(400);
  });

  it('returns the empty state honestly for a term nobody matches', async () => {
    const { status, body } = await api.get('/search?q=zamboanga');

    expect(status).toBe(200);
    expect((body as { results: unknown[] }).results).toHaveLength(0);
  });
});
