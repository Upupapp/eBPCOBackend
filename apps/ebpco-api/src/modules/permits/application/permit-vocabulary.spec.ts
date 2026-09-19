import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { PERMIT_NUMBER_PREFIXES, FALLBACK_PREFIX } from './permit.service';

/**
 * One vocabulary, and the gate that keeps it one.
 *
 * D-10, ruled 31 August 2026: the office's nineteen names are canonical. Until
 * migration 033 this service keyed its records on seventeen shorter names of
 * its own, and a lookup table in the code bridged the two. That table was a
 * cast -- a third spelling with no authority, invisible to every client -- and
 * the ruling abolished it.
 *
 * Deleting a cast is not the same as preventing one. What stops the two
 * vocabularies growing apart again is this file: the seeded table is asserted
 * against the SAME pinned fixture the deleted mapping was checked against,
 * `contract/permit-vocabulary.json`, which `npm run sync:permits` extracts from
 * the admin portal at a stamped commit. If either side moves, this fails.
 *
 * A spec that cannot be violated is not a spec, so each assertion below is one
 * that a wrong migration would actually fail.
 *
 * 047, 2026-09-19: seventeen names now, not nineteen. The three Building
 * Permit sub-types D-10 distinguished by name are one published type here
 * onward, `application_action` doing the distinguishing instead — see
 * 047's own comment and `requirements.spec.ts`. The fixture below was
 * hand-updated to match (its own header explains why the sync script
 * couldn't be re-run for this).
 */

const VOCABULARY = JSON.parse(
  readFileSync(join(__dirname, '../../../../contract/permit-vocabulary.json'), 'utf8'),
) as { admin: { commit: string; names: string[] }; portal: { commit: string; names: string[] } };

/**
 * Not one of the office's nineteen construction permits, and deliberately kept.
 *
 * The clients' legacy business-permit flow still files against it. Naming it
 * here as the single exception is what stops it being read as drift -- and what
 * makes its removal, if that flow is ever retired, a visible edit.
 */
const NOT_A_CONSTRUCTION_PERMIT = 'Business Permit';

let db: SqlClient;

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../../../../db/migrations')));
});

afterAll(async () => {
  await db.close();
});

const seeded = async (): Promise<string[]> => {
  const rows = await db.query<{ permit_type: string }>(
    'select permit_type from permit_types order by permit_type');
  return rows.rows.map((row) => row.permit_type);
};

describe('the permit vocabulary the office publishes', () => {
  it('is exactly what this service stores', async () => {
    // The whole of D-10 in one assertion. Nineteen office names plus the
    // legacy business permit, and nothing else.
    expect(await seeded()).toEqual([...VOCABULARY.admin.names, NOT_A_CONSTRUCTION_PERMIT].sort());
  });

  it('holds exactly one Building Permit entry, consolidated by 047', async () => {
    // Until 047 this was three rows -- New Construction, Renovation /
    // Alteration, Addition / Extension -- distinguished by an en dash (U+2013)
    // in the name. The product owner directed collapsing them into one
    // published type, with the real checklists now varying by
    // `application_action` instead (see requirements.spec.ts). Asserted on
    // the DATABASE rather than the fixture, same reasoning the en-dash check
    // this replaces always had: the fixture is where it is already right.
    const building = (await seeded()).filter((name) => name.startsWith('Building Permit'));

    expect(building).toEqual(['Building Permit']);
  });

  it('carries the three permits another office issues', async () => {
    // The scope half of the ruling: eBPCO accepts filings for the zoning
    // clearance the MPDC issues and the two the Bureau of Fire Protection
    // issues, so a citizen files in one place. Both clients already had wizards
    // for all three that could be filled in and not filed.
    expect(await seeded()).toEqual(expect.arrayContaining([
      'Zoning / Locational Clearance',
      'FSEC for Building Permit (BFP)',
      'FSIC for Occupancy Permit (BFP)',
    ]));
  });

  it('resolves the combined sanitary key into the two forms PD 1096 has', async () => {
    // 'Sanitary/Plumbing' was a stale combined key, not a category. This LGU
    // publishes NBC FORM NO. A-05 (Sanitary Permit) and NBC FORM NO. A-06
    // (Plumbing Permit) -- two forms, certified by different licensed
    // professionals. Both must exist and the combined name must be gone.
    const names = await seeded();

    expect(names).toContain('Sanitary Permit');
    expect(names).toContain('Plumbing Permit');
    expect(names).not.toContain('Sanitary/Plumbing');
  });

  it('leaves no application, requirement or officer assignment behind', async () => {
    // The rename travels through five foreign keys, one of which nothing in a
    // grep of `references permit_types` would have shown. Whatever referenced a
    // permit type before must still reference a row that exists -- an orphan
    // here is an officer assigned to a permit type that is gone, or a citizen's
    // application pointing at nothing.
    for (const table of ['applications', 'charter_entries', 'document_requirements',
      'fee_schedule_entries', 'staff_permit_access']) {
      const orphans = await db.query<{ n: string }>(
        `select count(*)::text as n from ${table} t
          where not exists (select 1 from permit_types p where p.permit_type = t.permit_type)`);

      expect(`${table}: ${orphans.rows[0]!.n}`).toBe(`${table}: 0`);
    }
  });

  it('gives every one of them a real permit-number prefix', async () => {
    // The rename changed every key in PERMIT_NUMBER_PREFIXES at once, and an
    // unrecognised type falls back to PRM rather than failing -- so nothing
    // would have thrown and every permit number issued afterwards would have
    // read PRM-2026-###### instead of BP-, FP-, SPP-. This reads the database
    // for exactly that reason.
    const missing = (await seeded()).filter((name) => PERMIT_NUMBER_PREFIXES[name] === undefined);

    expect(missing).toEqual([]);
    expect(Object.values(PERMIT_NUMBER_PREFIXES)).not.toContain(FALLBACK_PREFIX);
  });
});
