import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { permitCatalogueSchema, permitDetailSchema } from '../src/http/contract';
import { CANONICAL_PERMIT_NAMES } from '../src/permits/vocabulary';
import { Harness, harness } from './http-harness';

/** TAB 05 — the permit catalogue, and the vocabulary three repositories share. */

let api: Harness;

beforeAll(async () => { api = await harness(); }, 120000);
afterAll(async () => { await api.close(); });

const catalogue = async () => {
  const { status, body } = await api.get('/permits');
  expect(status).toBe(200);
  return permitCatalogueSchema.parse(body).groups;
};

const detailOf = async (slug: string) => {
  const { status, body } = await api.get(`/permits/${slug}`);
  expect(status).toBe(200);
  return permitDetailSchema.parse(body);
};

const flat = async () => (await catalogue()).flatMap((g) => g.permits);

describe('the canonical vocabulary', () => {
  const pinned = JSON.parse(
    readFileSync(join(__dirname, '../contract/permit-vocabulary.json'), 'utf8'),
  ) as { admin: { names: string[]; commit: string }; portal: { names: string[] } };

  it('matches the Web Admin ALL_PERMIT_TYPES by exact string AND index', () => {
    // TAB 05's criterion. Compared element by element rather than with one
    // deep-equal, so a failure names the index and the two strings — an en dash
    // and a hyphen are indistinguishable in a diff that just says 'not equal'.
    expect(pinned.admin.names).toHaveLength(CANONICAL_PERMIT_NAMES.length);

    CANONICAL_PERMIT_NAMES.forEach((name, index) => {
      expect(pinned.admin.names[index]).toBe(name);
    });
  });

  it('matches the public portal catalogue by exact string and index', () => {
    CANONICAL_PERMIT_NAMES.forEach((name, index) => {
      expect(pinned.portal.names[index]).toBe(name);
    });
  });

  it('holds the literal 19, not the length of its own array', () => {
    // The defect this replaces: the portal's own test named 'groups all 19
    // permit types' asserted that its data file equalled itself, which is true
    // of every data file.
    expect(CANONICAL_PERMIT_NAMES).toHaveLength(19);
    expect(CANONICAL_PERMIT_NAMES[0]).toBe('Building Permit – New Construction');
    expect(CANONICAL_PERMIT_NAMES[18]).toBe('FSIC for Occupancy Permit (BFP)');
  });

  it('keeps the punctuation that is load-bearing', () => {
    // An EN DASH, not a hyphen; spaces around the slash. A client sending the
    // hyphen version to the admin system is naming a permit that does not exist.
    expect(CANONICAL_PERMIT_NAMES[0]).toContain('–');
    expect(CANONICAL_PERMIT_NAMES[0]).not.toContain('-');
    expect(CANONICAL_PERMIT_NAMES).toContain('Civil / Structural Permit');
  });

  it('is the vocabulary the API actually serves', async () => {
    // The pinned files could agree with each other and with this module while
    // the database served something else entirely. Compared as a sorted list,
    // because the catalogue is GROUPED and grouping necessarily reorders — see
    // the ordering test below for what canonical order means once grouped.
    const served = (await flat()).map((p) => p.name).sort();

    expect(served).toEqual([...CANONICAL_PERMIT_NAMES].sort());
  });
});

describe('GET /permits', () => {
  it('returns exactly 19 permits, every canonical name and no other', async () => {
    const permits = await flat();

    // The literal 19, not the length of the array under test.
    expect(permits).toHaveLength(19);
    expect(new Set(permits.map((p) => p.name)))
      .toEqual(new Set(CANONICAL_PERMIT_NAMES));
  });

  it('keeps canonical order WITHIN each group', async () => {
    // Grouping cannot preserve the flat catalogue order: 'Zoning / Locational
    // Clearance' sits at canonical index 4, between engineering permits, and
    // the two BFP permits at 16 and 18 straddle 'Certificate of Occupancy'.
    // What must survive is each permit's position RELATIVE to its group —
    // reordering within a group would silently republish the catalogue.
    for (const group of await catalogue()) {
      const indices = group.permits.map(
        (p) => (CANONICAL_PERMIT_NAMES as readonly string[]).indexOf(p.name));

      expect(indices).not.toContain(-1);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it('groups them under the three labels the catalogue defines', async () => {
    const groups = await catalogue();

    expect(groups.map((g) => g.label)).toEqual([
      'Office of the Building Official', 'Zoning / Planning', 'Bureau of Fire Protection',
    ]);
    expect(groups.map((g) => g.permits.length)).toEqual([16, 1, 2]);
  });

  it('reports every permit as pending, honestly', async () => {
    // All 19 are unconfirmed: the requirements reflect general Philippine LGU
    // practice and have not been checked against Castilla's citizen's charter.
    const permits = await flat();

    for (const permit of permits) expect(permit.confirmationState).toBe('pending');
  });

  it('carries the state as data, so a confirmed permit says so', async () => {
    // The other half. Without it, a hardcoded 'pending' passes the test above.
    // Provenance first: the database refuses to confirm anything without a
    // source, and it refused this test's first draft. That refusal is the
    // schema working, so the test states a source rather than routing around it.
    await api.db.query(
      `insert into provenance (entity_type, entity_id, field_name, source_description,
                               sourced_on, method)
       select 'permit', p.id::text, 'record',
              'the Castilla citizen''s charter, permits section, read at the counter',
              date '2026-08-31', 'official-document'
         from permits p where p.slug = 'demolition-permit'`);
    await api.db.query(
      `update field_state set state = 'confirmed'
        where entity_type = 'permit' and entity_id in
              (select id::text from permits where slug = 'demolition-permit')`);

    const permit = (await flat()).find((p) => p.slug === 'demolition-permit');
    expect(permit?.confirmationState).toBe('confirmed');

    await api.db.query(
      `update field_state set state = 'pending'
        where entity_type = 'permit' and entity_id in
              (select id::text from permits where slug = 'demolition-permit')`);
  });
});

describe('GET /permits/{slug}', () => {
  it('validates against the contract for all 19', async () => {
    for (const permit of await flat()) {
      const detail = await detailOf(permit.slug);
      expect(detail.requirements.length).toBeGreaterThan(0);
    }
  });

  it('404s a permit it does not publish', async () => {
    expect((await api.get('/permits/dog-licence')).status).toBe(404);
  });

  it('keeps requirements in the published order', async () => {
    const detail = await detailOf('building-permit-new-construction');

    expect(detail.requirements[0]).toBe('Land title or tax declaration for the property');
    expect(detail.requirements).toContain('Bill of materials');
  });

  it('carries the process note where one exists', async () => {
    const detail = await detailOf('building-permit-new-construction');

    expect(detail.processNote).toContain('Zoning / Locational Clearance');
  });
});

describe('the two BFP permits are not municipal', () => {
  it('names the issuing body as text with no office link', async () => {
    // TAB 05's guard: the Bureau of Fire Protection is a national agency with
    // no municipal office record, and must not be merged into one for tidiness.
    for (const slug of ['fsec-building-permit', 'fsic-occupancy-permit']) {
      const detail = await detailOf(slug);

      expect(detail.issuingOffice.name).toContain('Bureau of Fire Protection');
      expect(detail.issuingOffice.slug).toBeUndefined();
    }
  });

  it('gives municipal permits a slug that resolves to a real office', async () => {
    // The other half, and it proves the link is usable rather than merely
    // present.
    const detail = await detailOf('building-permit-new-construction');
    expect(detail.issuingOffice.slug).toBeDefined();

    expect((await api.get(`/offices/${detail.issuingOffice.slug!}`)).status).toBe(200);
  });

  it('never invented a BFP office row', async () => {
    const offices = await api.db.query<{ n: number }>(
      "select count(*)::int as n from offices where name ilike '%fire protection%'");

    expect(offices.rows[0]!.n).toBe(0);
  });
});

describe('application forms', () => {
  it('gives 14 permits a form and the other 5 none', async () => {
    let withForm = 0;
    let withoutForm = 0;
    for (const permit of await flat()) {
      const detail = await detailOf(permit.slug);
      if (detail.formUrl === undefined) withoutForm += 1; else withForm += 1;
    }

    expect(withForm).toBe(14);
    expect(withoutForm).toBe(5);
  });

  it('omits the form key rather than sending an empty string', async () => {
    // The 5 without a form must render with no download link, not a broken one.
    const detail = await detailOf('demolition-permit');

    expect('formUrl' in detail).toBe(false);
  });

  it('serves the one combined checklist on the four permits that cite it', async () => {
    // These were ALL null until 2026-08-31: the checklist is a module-private
    // const initialised by a helper call, and the extractor captured only
    // EXPORTED declarations, so four download links silently did not exist.
    let withChecklist = 0;
    for (const permit of await flat()) {
      const detail = await detailOf(permit.slug);
      if (detail.checklistUrl !== undefined) {
        expect(detail.checklistUrl).toBe('/assets/permits/Building-Permit-and-Occupancy-Checklist.pdf');
        withChecklist += 1;
      }
    }

    expect(withChecklist).toBe(4);
  });

  it('points only at bundled assets, never off-site', async () => {
    // A government form served from somewhere else is how a phishing page gets
    // a foothold. Held by a database constraint as well as by this test.
    for (const permit of await flat()) {
      const detail = await detailOf(permit.slug);
      for (const url of [detail.formUrl, detail.checklistUrl]) {
        if (url !== undefined) expect(url.startsWith('/assets/permits/')).toBe(true);
      }
    }
  });
});
