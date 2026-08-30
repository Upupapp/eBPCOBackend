import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/persistence/migrator';

/**
 * TAB 01's acceptance criteria, against real PostgreSQL.
 *
 * PGlite is a real PostgreSQL build running in-process, which matters more here
 * than usual: the central requirement is that a confirmed value with no
 * provenance is refused BY THE DATABASE rather than by application code. A test
 * against a stand-in would assert the stand-in.
 */

const MIGRATIONS = join(__dirname, '../db/migrations');

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await migrate(db, MIGRATIONS);
  await db.exec(`
    insert into office_categories (id, label, ordinal) values ('executive', 'Executive', 1);
    -- head_name is set because 005 refuses a CONFIRMED head with no name to
    -- serve, and several tests below confirm this office's head. An office
    -- fixture without one is not a valid office.
    insert into offices (id, slug, name, category_id, short_description, about_text, ordinal,
                         head_name, head_position)
    values ('11111111-1111-4111-8111-111111111111', 'office-of-the-mayor',
            'Office of the Municipal Mayor', 'executive', 'The executive office.',
            'About the office.', 1, 'Isagani "Bong" B. Mendoza', 'Municipal Mayor');
  `);
});

afterEach(async () => {
  await db.close();
});

const confirm = (field: string) => db.exec(
  `insert into field_state (entity_type, entity_id, field_name, state)
   values ('office', '11111111-1111-4111-8111-111111111111', '${field}', 'confirmed')`,
);

const source = (field: string) => db.exec(
  `insert into provenance (entity_type, entity_id, field_name, source_description,
                           source_url, sourced_on, method)
   values ('office', '11111111-1111-4111-8111-111111111111', '${field}',
           'the 2025 local election results, cross-checked against two independent sources',
           'https://example.ph/results', '2026-08-23', 'search-extraction')`,
);

describe('confirmed implies provenance, and the DATABASE says so', () => {
  it('refuses a confirmed field with no provenance record', async () => {
    // The acceptance criterion, stated exactly: rejected by the database, not
    // by application code. A second write path cannot forget this.
    await expect(confirm('head')).rejects.toThrow(/without a provenance record/);
  });

  it('accepts a confirmed field once its provenance exists', async () => {
    // The other half. Without it the test above passes just as well against a
    // trigger that refuses everything.
    await source('head');
    await expect(confirm('head')).resolves.toBeDefined();
  });

  it('accepts provenance written AFTER the confirmation in one transaction', async () => {
    // Why the trigger is deferred. Requiring provenance to be inserted first is
    // a rule about statement order wearing the costume of a rule about data,
    // and it would make the confirmation endpoint's SQL order load-bearing.
    await expect(db.exec(`
      begin;
      insert into field_state (entity_type, entity_id, field_name, state)
      values ('office', '11111111-1111-4111-8111-111111111111', 'telephone', 'confirmed');
      insert into provenance (entity_type, entity_id, field_name, source_description,
                              sourced_on, method)
      values ('office', '11111111-1111-4111-8111-111111111111', 'telephone',
              'the LGU Citizen''s Charter, read directly', '2026-08-23', 'official-document');
      commit;
    `)).resolves.toBeDefined();
  });

  it('refuses a confirmation that rolls its provenance back', async () => {
    // The deferral must not become a loophole. A transaction that inserts
    // provenance, confirms, then removes the provenance has to fail at COMMIT.
    await expect(db.exec(`
      begin;
      insert into provenance (entity_type, entity_id, field_name, source_description,
                              sourced_on, method)
      values ('office', '11111111-1111-4111-8111-111111111111', 'email',
              'a source that will be withdrawn before commit', '2026-08-23', 'direct-read');
      insert into field_state (entity_type, entity_id, field_name, state)
      values ('office', '11111111-1111-4111-8111-111111111111', 'email', 'confirmed');
      delete from provenance where field_name = 'email';
      commit;
    `)).rejects.toThrow(/without a provenance record/);
  });

  it('allows pending and withheld with no provenance at all', async () => {
    // Pending is the default and the common case: a fact nobody has confirmed
    // has nothing to cite. Withheld is a decision not to publish, which is not
    // a claim about a source either.
    await expect(db.exec(
      `insert into field_state (entity_type, entity_id, field_name, state) values
       ('office', '11111111-1111-4111-8111-111111111111', 'location', 'pending'),
       ('office', '11111111-1111-4111-8111-111111111111', 'hours', 'withheld')`,
    )).resolves.toBeDefined();
  });

  it("refuses 'LGU' as a source", async () => {
    // TAB 02's guardrail, enforced where it cannot be skipped.
    await expect(db.exec(
      `insert into provenance (entity_type, entity_id, field_name, source_description,
                               sourced_on, method)
       values ('office', '11111111-1111-4111-8111-111111111111', 'head', 'LGU',
               '2026-08-23', 'direct-read')`,
    )).rejects.toThrow();
  });
});

describe('what the schema refuses to lose', () => {
  it('keeps provenance when the office it describes is deleted', async () => {
    // No cascade, deliberately. "Why did the portal once say this" outlives the
    // record, and an orphan row is a smaller loss than an erased reason.
    await source('head');
    await db.exec("delete from office_related where true");
    await db.exec("delete from offices where slug = 'office-of-the-mayor'");

    const left = await db.query<{ n: number }>('select count(*)::int as n from provenance');

    expect(left.rows[0]!.n).toBe(1);
  });

  it('has NO foreign key from provenance to anything, so none can cascade', async () => {
    // Stronger than deleting an office and counting rows, and the reason is a
    // break-check that failed to bite: adding a nullable cascading FK to
    // provenance leaves existing rows untouched, so the row-count test passed
    // against a schema that would destroy provenance for anything written
    // afterwards. The invariant is structural, so it is checked structurally.
    const keys = await db.query<{ constraint_name: string }>(`
      select constraint_name from information_schema.table_constraints
       where table_name = 'provenance' and constraint_type = 'FOREIGN KEY'`);

    expect(keys.rows).toEqual([]);
  });

  it('lets a permit carry no issuing office', async () => {
    // The two BFP permits. The Bureau of Fire Protection is a national agency
    // with no municipal office record, and no seeder may invent one.
    await db.exec(`
      insert into permit_office_groups (id, label, ordinal) values ('bfp', 'Bureau of Fire Protection', 3);
      insert into permits (slug, name, office_group_id, issuing_office_id, issuing_office_name,
                           description, validity, ordinal)
      values ('fsec-for-building-permit-bfp', 'FSEC for Building Permit (BFP)', 'bfp', null,
              'Bureau of Fire Protection', 'Fire safety evaluation.', '12 months', 17);
    `);

    const row = await db.query<{ issuing_office_id: string | null }>(
      "select issuing_office_id from permits where slug = 'fsec-for-building-permit-bfp'",
    );

    expect(row.rows[0]!.issuing_office_id).toBeNull();
  });

  it('refuses a profile suffix with no count behind it', async () => {
    // A suffix or a precision without a magnitude describes nothing, and the
    // magnitude is authored rather than parsed back out of the display string.
    await expect(db.exec(
      `insert into profile_fields (label, value, count_suffix, ordinal)
       values ('ZIP Code', '4713', '(2020 Census)', 8)`,
    )).rejects.toThrow();
  });
});

describe('a confirmed head must be nameable', () => {
  it('refuses confirming a head the database cannot name', async () => {
    // The gap this closed: 15 offices carried `head: confirmed` while the only
    // head column was a link into the ELECTED roster, which appointed
    // department heads are not in. The state was recorded faithfully and the
    // name was discarded, so the API had nothing to serve and no test noticed.
    await db.exec(
      `update offices set head_name = null, head_position = null
        where id = '11111111-1111-4111-8111-111111111111'`);
    await source('head');

    await expect(confirm('head')).rejects.toThrow(/confirmed head with no name/);
  });

  it('accepts a head named on the office itself, not only an elected one', async () => {
    await source('head');

    await expect(confirm('head')).resolves.toBeDefined();
  });

  it('refuses an office claiming a head from both sources at once', async () => {
    // Two answers to "who runs this office" means whichever the query reads
    // first wins, silently.
    await db.exec(`insert into officials (id, slug, name, position, office, initials, ordinal)
                   values ('22222222-2222-4222-8222-222222222222', 'a-person', 'A Person',
                           'Municipal Mayor', 'Office of the Municipal Mayor', 'AP', 1)`);

    await expect(db.exec(
      `update offices set head_official_id = '22222222-2222-4222-8222-222222222222'
        where id = '11111111-1111-4111-8111-111111111111'`),
    ).rejects.toThrow(/office_head_has_one_source/);
  });
});
