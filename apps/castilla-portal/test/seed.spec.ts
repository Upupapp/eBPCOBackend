import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/persistence/migrator';
import { Seeder } from '../src/seed/seeder';
import { ExtractedPortalData } from '../src/seed/extracted';

/**
 * TAB 15's acceptance criteria, against real PostgreSQL and the real extraction.
 *
 * The fixture is `contract/portal-data.json`, extracted from a pinned commit of
 * the portal repository by `npm run extract:portal`. Not a hand-written sample:
 * a seeder tested against data somebody wrote to make it pass proves only that
 * it agrees with itself.
 */

const data = JSON.parse(
  readFileSync(join(__dirname, '../contract/portal-data.json'), 'utf8'),
) as ExtractedPortalData;

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await migrate(db, join(__dirname, '../db/migrations'));
});

afterEach(async () => {
  await db.close();
});

const seed = () => new Seeder(db).run(data);
const count = async (table: string): Promise<number> =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

describe('the counts match the measured baseline', () => {
  it('imports exactly what the portal committed', async () => {
    const report = await seed();

    // The literal numbers from the Master Command's baseline, not the length of
    // the seeder's own arrays.
    expect(report.counts).toEqual({
      offices: 19, officeCategories: 6, officials: 12,
      permits: 19, permitGroups: 3, profileFields: 11,
    });
    expect(await count('offices')).toBe(19);
    expect(await count('permits')).toBe(19);
    expect(await count('officials')).toBe(12);
  });

  it('records which portal commit it read', async () => {
    // A seeded database that cannot say what it was seeded from is a database
    // nobody can reconcile.
    expect((await seed()).portalCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('never auto-confirm', () => {
  it('confirms 17 office heads and leaves 2 pending', async () => {
    await seed();

    const heads = await db.query<{ state: string; n: number }>(
      `select state::text, count(*)::int as n from field_state
        where entity_type = 'office' and field_name = 'head' group by state`,
    );
    const by = Object.fromEntries(heads.rows.map((r) => [r.state, r.n]));

    expect(by['confirmed']).toBe(17);
    expect(by['pending']).toBe(2);
  });

  it('leaves every permit unconfirmed', async () => {
    // All 19 reflect general Philippine LGU practice and have not been checked
    // against Castilla's own citizen's charter. The API must be able to say so.
    await seed();

    const permits = await db.query<{ n: number }>(
      `select count(*)::int as n from field_state
        where entity_type = 'permit' and state = 'confirmed'`,
    );

    expect(permits.rows[0]!.n).toBe(0);
  });

  it('gives every confirmed field a provenance record', async () => {
    // The database enforces this, so a failure here means the seeder found a
    // way to confirm something without reading a source -- which it cannot,
    // but asserting it makes the guarantee visible rather than implicit.
    await seed();

    const orphans = await db.query<{ n: number }>(`
      select count(*)::int as n from field_state f
       where f.state = 'confirmed' and not exists (
         select 1 from provenance p where p.entity_type = f.entity_type
           and p.entity_id = f.entity_id and p.field_name = f.field_name)`);

    expect(orphans.rows[0]!.n).toBe(0);
  });

  it('reports what it could not source rather than confirming it anyway', async () => {
    // The honest half of "never auto-confirm": a value whose comment carries no
    // date, or no phrase saying how the fact was obtained, stays pending and is
    // named in the reconciliation.
    const report = await seed();

    for (const gap of report.unsourced) {
      expect(gap.reason).toMatch(/no comment|no sourced-on date|how the fact was obtained/);
    }
  });
});

describe('idempotency', () => {
  it('writes nothing on a second run', async () => {
    // TAB 15's criterion, measured rather than asserted: the seeder counts its
    // own writes, and a conditional upsert that changed nothing does not count.
    const first = await seed();
    expect(first.writes).toBeGreaterThan(0);

    const second = await seed();

    expect(second.writes).toBe(0);
  });

  it('creates no duplicate provenance rows', async () => {
    await seed();
    const after = await count('provenance');

    await seed();
    await seed();

    expect(await count('provenance')).toBe(after);
  });

  it('does not rewrite ordered lists that have not changed', async () => {
    // Services and requirements are ordered, so the naive implementation is
    // delete-and-reinsert every run -- which is invisible in row counts and is
    // exactly the write TAB 15 says must not happen.
    await seed();
    const services = await count('office_services');

    const second = await seed();

    expect(await count('office_services')).toBe(services);
    expect(second.writes).toBe(0);
  });
});

describe('what the seeder must not repair', () => {
  it('keeps the two BFP permits without an issuing office', async () => {
    await seed();

    // Asserted by what they ARE, not by slugs I guessed: the first version of
    // this test hard-coded invented slugs and failed against correct data.
    const bfp = await db.query<{ slug: string; name: string; body: string }>(
      `select slug, name, issuing_office_name as body from permits
        where issuing_office_id is null order by ordinal`,
    );

    expect(bfp.rows).toHaveLength(2);
    for (const row of bfp.rows) {
      expect(row.name).toMatch(/BFP/);
      // The issuing body is still named, as text. A citizen is told who issues
      // it; there is simply no municipal office to link to.
      expect(row.body).toMatch(/Bureau of Fire Protection/);
    }
  });

  it('preserves the committed order rather than sorting', async () => {
    // The office listing groups executive offices first and TAB 03 forbids
    // sorting by name. A set has no order, so the order is stored.
    await seed();

    const first = await db.query<{ slug: string }>(
      'select slug from offices order by ordinal limit 1',
    );

    expect(first.rows[0]!.slug).toBe('office-of-the-mayor');
  });

  it('gives the Mayor’s office the same record /officials serves', async () => {
    // One fact, one row. The portal previously named the Mayor on one page and
    // showed his office as headless on another, because each carried a copy.
    await seed();

    const joined = await db.query<{ name: string }>(`
      select o2.name from offices o
        join officials o2 on o2.id = o.head_official_id
       where o.slug = 'office-of-the-mayor'`);

    expect(joined.rows[0]!.name).toMatch(/Mendoza/);
  });
});
