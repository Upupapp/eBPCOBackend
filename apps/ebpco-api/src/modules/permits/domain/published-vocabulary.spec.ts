import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import {
  KEYS_WITHOUT_A_PUBLISHED_NAME, PUBLISHED_NAMES_WITHOUT_A_KEY, PUBLISHED_NAME_BY_KEY,
} from './published-vocabulary';

/**
 * The drift gate TAB 05 asks for, and the mapping it revealed was missing.
 *
 * The 19 published permit names are held by the admin portal and the public
 * information portal. They match verbatim and in order -- and nothing checked
 * it: the portal's own test named "groups all 19 permit types" asserts only
 * that its data file equals itself.
 *
 * The fixture is extracted by `npm run sync:permits`, which reads both sources
 * at their COMMITTED state and stamps the commit on the result. Re-running it
 * after either side changes is what makes drift visible here.
 */

const VOCABULARY = JSON.parse(
  readFileSync(join(__dirname, '../../../../contract/permit-vocabulary.json'), 'utf8'),
) as {
  admin: { commit: string; names: string[] };
  portal: { commit: string; names: string[] };
};

let db: SqlClient;

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../../../../db/migrations')));
});

afterAll(async () => {
  await db.close();
});

describe('the admin portal and the public portal publish the same catalogue', () => {
  it('agrees verbatim and in order', () => {
    // Index-sensitive, not set equality. The catalogue is ordered and a client
    // that renders it in order would silently reorder if this only compared
    // membership.
    expect(VOCABULARY.portal.names).toEqual(VOCABULARY.admin.names);
  });

  it('still has nineteen of them', () => {
    // The literal, not the length of its own array -- the exact mistake the
    // portal's own test makes.
    expect(VOCABULARY.admin.names).toHaveLength(19);
  });

  it('preserves the characters that are load-bearing', () => {
    // An en dash, not a hyphen; spaces around the slash. Both survive a diff
    // and neither survives an editor that "tidies" punctuation, which is
    // exactly the drift this gate exists to catch.
    expect(VOCABULARY.admin.names).toContain('Building Permit – New Construction');
    expect(VOCABULARY.admin.names).toContain('Civil / Structural Permit');
    expect(VOCABULARY.admin.names).not.toContain('Building Permit - New Construction');
  });

  it('was extracted from a real commit on each side', () => {
    // Without this the fixture is a hand transcription wearing a filename.
    expect(VOCABULARY.admin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(VOCABULARY.portal.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('every internal permit key is accounted for', () => {
  const storedKeys = async (): Promise<string[]> =>
    (await db.query<{ permit_type: string }>(
      'select permit_type from permit_types order by permit_type',
    )).rows.map((row) => row.permit_type);

  it('maps or explains all seventeen, and nothing else', async () => {
    // Both ways. A key that gains a mapping must leave the unexplained list,
    // and a key added to `permit_types` with neither a mapping nor a reason
    // fails here rather than being discovered by a citizen seeing a permit
    // name this service made up.
    const accounted = [
      ...Object.keys(PUBLISHED_NAME_BY_KEY),
      ...Object.keys(KEYS_WITHOUT_A_PUBLISHED_NAME),
    ].sort();

    expect(accounted).toEqual(await storedKeys());
  });

  it('never maps two keys to one published name', async () => {
    // The failure this prevents is silent: two internal permits collapsing
    // into one citizen-facing name, so a sanitary permit and a plumbing permit
    // become indistinguishable in anything the citizen reads.
    const mapped = Object.values(PUBLISHED_NAME_BY_KEY);

    expect(new Set(mapped).size).toBe(mapped.length);
    expect(await storedKeys()).toHaveLength(17);
  });
});

describe('every published name is accounted for', () => {
  it('is either mapped from a key or explained as unfilable', () => {
    const accounted = [
      ...Object.values(PUBLISHED_NAME_BY_KEY),
      ...Object.keys(PUBLISHED_NAMES_WITHOUT_A_KEY),
    ].sort();

    expect(accounted).toEqual([...VOCABULARY.admin.names].sort());
  });

  it('names four the citizen cannot file here, which is the finding', () => {
    // Not a tidying problem. Zoning goes to the Planning Office and the two
    // BFP permits go to a national agency -- a citizen reads about them on the
    // portal and has nowhere to file them in this system. Asserted so the
    // number cannot quietly grow.
    expect(Object.keys(PUBLISHED_NAMES_WITHOUT_A_KEY)).toHaveLength(4);
  });
});
