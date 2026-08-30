import { officeDetailSchema, officeListSchema } from '../src/http/contract';
import { Harness, harness } from './http-harness';

/** TAB 03 — public read API for municipal offices. */

let api: Harness;

beforeAll(async () => { api = await harness(); }, 120000);
afterAll(async () => { await api.close(); });

const detailOf = async (slug: string) => {
  const { status, body } = await api.get(`/offices/${slug}`);
  expect(status).toBe(200);
  return officeDetailSchema.parse(body);
};

describe('GET /offices', () => {
  it('lists all 19 offices', async () => {
    const { status, body } = await api.get('/offices');

    expect(status).toBe(200);
    expect(officeListSchema.parse(body).offices).toHaveLength(19);
  });

  it('keeps the committed order, which is not alphabetical', async () => {
    // The order groups executive offices first and TAB 03 forbids re-sorting.
    // Asserted as "not alphabetical" AND by its first entry, because a list
    // that happened to be sorted would satisfy either check alone.
    const { offices } = officeListSchema.parse((await api.get('/offices')).body);
    const names = offices.map((o) => o.name);

    expect(names[0]).toBe('Office of the Municipal Mayor');
    expect(names).not.toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('filters by category', async () => {
    const { offices } = officeListSchema.parse((await api.get('/offices?category=finance')).body);

    expect(offices.length).toBeGreaterThan(0);
    for (const office of offices) expect(office.category).toBe('finance');
  });

  it('refuses an unknown category rather than returning an empty list', async () => {
    // Empty is a truthful answer to a real category, so it must not double as
    // the answer to a typo.
    const { status, body } = await api.get('/offices?category=finanace');

    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('finance');
  });
});

describe('GET /offices/{slug}', () => {
  it('validates against the contract for every one of the 19', async () => {
    const { offices } = officeListSchema.parse((await api.get('/offices')).body);

    for (const office of offices) {
      const detail = await detailOf(office.slug);
      expect(detail.slug).toBe(office.slug);
    }
  });

  it('404s a slug it does not publish', async () => {
    const { status } = await api.get('/offices/office-of-the-postmaster');

    expect(status).toBe(404);
  });

  it("includes the Engineering Office's building permits", async () => {
    // TAB 03's named criterion.
    const detail = await detailOf('municipal-engineering');
    const names = detail.issuedPermits.map((p) => p.name);

    expect(names).toEqual(expect.arrayContaining([
      'Building Permit – New Construction',
      'Certificate of Occupancy',
      'Demolition Permit',
    ]));
  });

  it('derives issued permits rather than duplicating them onto the office', async () => {
    // The relationship is read from the permit records. Every issued permit
    // must name this office as its issuer, or the two have been allowed to
    // disagree.
    const detail = await detailOf('municipal-engineering');
    const issuers = await api.db.query<{ slug: string }>(
      `select p.slug from permits p join offices o on o.id = p.issuing_office_id
        where o.slug = 'municipal-engineering'`);

    expect(detail.issuedPermits.map((p) => p.slug).sort())
      .toEqual(issuers.rows.map((r) => r.slug).sort());
  });
});

describe('unconfirmed content is withheld, not signalled', () => {
  it('omits the head key entirely when the head is pending', async () => {
    // Two offices have a pending head. The key must be ABSENT — not null, not
    // an empty object.
    const pending = await api.db.query<{ slug: string }>(
      `select o.slug from offices o join field_state fs
              on fs.entity_id = o.id::text and fs.field_name = 'head'
        where fs.state = 'pending'`);
    expect(pending.rows.length).toBe(2);

    for (const row of pending.rows) {
      const { body } = await api.get(`/offices/${row.slug}`);
      expect(Object.keys(body as object)).not.toContain('head');
    }
  });

  it('serves the head when it is confirmed', async () => {
    // The other half: the test above passes equally against an API that never
    // returns a head at all.
    const detail = await detailOf('office-of-the-mayor');

    expect(detail.head?.name).toContain('Mendoza');
  });

  it('serves an appointed head, not only the two elected ones', async () => {
    // 15 of the 17 confirmed heads are appointed department heads written
    // inline on the office. Until 2026-08-30 their names were dropped during
    // seeding, so field_state said 'confirmed' for 17 offices the database
    // could name 2 of.
    const detail = await detailOf('municipal-administrator');

    expect(detail.head?.name).toBe('Atty. Marilyn D. Valino');
    expect(detail.head?.position).toBe('Municipal Administrator');
  });

  it('withholds a head whose NAME exists but whose state is pending', async () => {
    // The guard that matters, isolated. The two pending-head offices have no
    // stored name either, so every other assertion here passes against an API
    // with no state check at all — absence of the value hides absence of the
    // rule. Give the office a name and the state filter is the only thing
    // left standing between it and the wire.
    const office = await api.db.query<{ id: string; slug: string }>(
      `select o.id, o.slug from offices o join field_state fs
              on fs.entity_id = o.id::text and fs.field_name = 'head'
        where fs.state = 'pending' limit 1`);
    const { id, slug } = office.rows[0]!;
    await api.db.query(
      `update offices set head_name = $2, head_position = 'ABC President' where id = $1`,
      [id, 'Someone Not Yet Confirmed']);

    const { body } = await api.get(`/offices/${slug}`);

    expect(Object.keys(body as object)).not.toContain('head');
    expect(JSON.stringify(body)).not.toContain('Someone Not Yet Confirmed');

    await api.db.query(
      'update offices set head_name = null, head_position = null where id = $1', [id]);
  });

  it("never emits the 'Pending confirmation' sentinel anywhere", async () => {
    // Swept across every response rather than spot-checked: the sentinel is a
    // front-end workaround, and an API that reproduced it would make it
    // permanent.
    const { offices } = officeListSchema.parse((await api.get('/offices')).body);
    const bodies = [JSON.stringify((await api.get('/offices')).body)];
    for (const office of offices) {
      bodies.push(JSON.stringify((await api.get(`/offices/${office.slug}`)).body));
    }

    for (const body of bodies) expect(body.toLowerCase()).not.toContain('pending confirmation');
  });

  it('omits contact entirely while no contact field is confirmed', async () => {
    // All 76 contact fields are currently pending or withheld, so no office
    // publishes one. An empty object would be a null-filled shape by another
    // name.
    const { offices } = officeListSchema.parse((await api.get('/offices')).body);

    for (const office of offices) {
      const { body } = await api.get(`/offices/${office.slug}`);
      expect(Object.keys(body as object)).not.toContain('contact');
    }
  });

  it('publishes a contact field once it is confirmed, and only that one', async () => {
    // The break-check written as a test: without it, every assertion above is
    // satisfied by an API that withholds unconditionally.
    await api.db.query(
      `insert into provenance (entity_type, entity_id, field_name, source_description,
                               sourced_on, method)
       select 'office', o.id::text, 'contact.telephone',
              'the LGU Citizen''s Charter, page 12, read at the counter',
              date '2026-08-30', 'official-document'
         from offices o where o.slug = 'municipal-civil-registrar'`);
    await api.db.query(
      `update field_state set state = 'confirmed'
        where field_name = 'contact.telephone' and entity_id in
              (select id::text from offices where slug = 'municipal-civil-registrar')`);

    const detail = await detailOf('municipal-civil-registrar');

    expect(detail.contact).toBeDefined();
    expect(Object.keys(detail.contact ?? {})).toEqual(['telephone']);
  });
});

describe('related offices resolve', () => {
  it('returns name and slug, so the client renders links without a second call', async () => {
    const detail = await detailOf('municipal-administrator');

    expect(detail.relatedOffices.length).toBeGreaterThan(0);
    for (const related of detail.relatedOffices) {
      expect(related.name.length).toBeGreaterThan(0);
    }
  });

  it('never returns a dangling slug — every relation is an office this API serves', async () => {
    // The criterion, swept across all 19. `office_related` was empty until
    // 2026-08-30, which would have made this pass vacuously.
    const { offices } = officeListSchema.parse((await api.get('/offices')).body);
    const served = new Set(offices.map((o) => o.slug));
    let seen = 0;

    for (const office of offices) {
      const detail = await detailOf(office.slug);
      for (const related of detail.relatedOffices) {
        expect(served.has(related.slug)).toBe(true);
        seen += 1;
      }
    }

    // The sweep must have had something to sweep.
    expect(seen).toBe(46);
  });
});
