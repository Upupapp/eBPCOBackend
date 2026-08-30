import { join } from 'node:path';

import { PgliteClient } from './pglite-client';
import { SqlClient } from './sql-client';
import { loadMigrations, migrate } from './migrator';
import { gaps, inventory } from './personal-data-inventory';

const MIGRATIONS_DIR = join(__dirname, '../../db/migrations');

describe('personal data inventory', () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await PgliteClient.create();
    await migrate(db, loadMigrations(MIGRATIONS_DIR));
  });
  afterAll(async () => {
    await db.close();
  });

  it('is generated from the schema, not maintained by hand', async () => {
    // A hand-written register is accurate the day it is written and wrong by
    // the next migration -- and TAB 20 has to file it with the NPC.
    const entries = await inventory(db);

    expect(entries.length).toBeGreaterThan(5);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'accounts', column: 'email', classification: 'pii' }),
        expect.objectContaining({ table: 'applicants', column: 'first_name', classification: 'pii' }),
        expect.objectContaining({ table: 'businesses', column: 'barangay', classification: 'pii' }),
      ]),
    );
  });

  it('records a lawful basis against every personal-data column', async () => {
    // RA 10173 requires each field to map to a purpose and a basis. A tag with
    // no note is a column nobody has justified collecting.
    const personal = (await inventory(db)).filter((entry) => entry.classification === 'pii');

    for (const entry of personal) {
      expect(entry.note.length).toBeGreaterThan(10);
    }
  });

  it('separates credentials from personal data', async () => {
    // A password verifier is not personal data, but it must never be exported
    // or logged -- a different rule, so a different classification.
    const credentials = (await inventory(db)).filter((entry) => entry.classification === 'credential');

    expect(credentials.map((entry) => `${entry.table}.${entry.column}`)).toEqual(
      expect.arrayContaining(['accounts.password_hash', 'refresh_tokens.secret_digest']),
    );
  });

  it('finds no untagged column that looks like personal data', async () => {
    // The gate: adding an untagged `email` column fails the build rather than
    // quietly leaving it out of the register.
    expect(await gaps(db)).toEqual([]);
  });

  it('would catch an untagged personal-data column', async () => {
    // Proving the gate bites, rather than trusting that it does.
    await db.exec('create table probe_table (id int, email text)');
    try {
      expect(await gaps(db)).toEqual([
        expect.objectContaining({ table: 'probe_table', column: 'email' }),
      ]);
    } finally {
      await db.exec('drop table probe_table');
    }
  });
});
