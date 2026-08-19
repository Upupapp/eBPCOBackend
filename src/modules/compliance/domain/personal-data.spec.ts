import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { REGISTER, personalDataColumns } from './personal-data';

/**
 * The register has to be COMPLETE, or it is a list of the personal data someone
 * happened to think of.
 *
 * That difference is invisible until a breach notification has to enumerate
 * what was disclosed, or a data subject asks what is held about them. These
 * tests read the live schema and refuse anything the register does not mention.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

let db: SqlClient;
let live: { table: string; column: string }[];

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  const result = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' order by table_name, ordinal_position`,
  );
  live = result.rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('completeness', () => {
  it('classifies every column in the database', () => {
    // The gate. A new column must be classified to merge, so "we forgot to
    // decide" is not a state this repository can be in.
    const unclassified = live
      .filter(({ table, column }) => REGISTER[table]?.[column] === undefined)
      .map(({ table, column }) => `${table}.${column}`);

    expect(unclassified).toEqual([]);
  });

  it('classifies every table in the database', () => {
    const tables = [...new Set(live.map((c) => c.table))];

    expect(tables.filter((table) => REGISTER[table] === undefined)).toEqual([]);
  });

  it('has no entry for a column that no longer exists', () => {
    // A stale register is a register that has stopped being read. A dropped
    // column left classified means the file was not looked at when it was
    // dropped, and the next reader trusts it anyway.
    const present = new Set(live.map(({ table, column }) => `${table}.${column}`));
    const stale = Object.entries(REGISTER).flatMap(([table, columns]) =>
      Object.keys(columns)
        .map((column) => `${table}.${column}`)
        .filter((key) => !present.has(key)),
    );

    expect(stale).toEqual([]);
  });
});

describe('every classification is usable', () => {
  it('names a lawful basis for anything that is about a person', () => {
    // RA 10173 §12: processing needs a basis. A column classified as personal
    // data with no stated reason for holding it is one nobody can defend.
    const unjustified = personalDataColumns()
      .filter(({ rule }) => rule.basis === undefined || rule.basis.trim() === '')
      .map(({ table, column }) => `${table}.${column}`);

    expect(unjustified).toEqual([]);
  });

  it('never claims a secret is exportable', () => {
    // A subject-access export must not hand back a password verifier or a TOTP
    // secret. They are about the person, and disclosing them is not access —
    // it is handing over the means to impersonate them.
    const secrets = personalDataColumns().filter(({ rule }) => rule.dataClass === 'secret');

    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(secret.rule.retention).toBe('account-lifetime');
    }
  });

  it('keeps audit-class columns out of account-lifetime deletion', () => {
    // Deleting an audit entry breaks the chain, and a broken chain is
    // indistinguishable from a forged one.
    const audit = Object.entries(REGISTER.audit_events ?? {});

    expect(audit.length).toBeGreaterThan(0);
    for (const [, rule] of audit) {
      expect(rule.retention).toBe('audit');
    }
  });
});

describe('the schema comments and the register agree', () => {
  it('classifies every pii-tagged column as personal data', async () => {
    // The nineteen `pii:` comments are for whoever reads the schema directly.
    // If they and this file disagree, one of them is wrong and there is no way
    // to tell which from either side alone.
    const tagged = await db.query<{ table_name: string; column_name: string }>(
      `select c.relname as table_name, a.attname as column_name
         from pg_description d
         join pg_class c on c.oid = d.objoid
         join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
        where d.description like 'pii:%'`,
    );

    expect(tagged.rows.length).toBeGreaterThan(0);
    const disagreements = tagged.rows
      .filter((row) => REGISTER[row.table_name]?.[row.column_name]?.dataClass === 'none')
      .map((row) => `${row.table_name}.${row.column_name}`);

    expect(disagreements).toEqual([]);
  });
});

describe('what the register says about erasure', () => {
  it('marks the applicant’s own name as statutory, not account-lifetime', () => {
    // The decision that matters most, and the one most likely to be got wrong
    // by someone implementing "delete my account". The name on a permit is part
    // of the permit: PD 1096 requires the record, and the record is not a
    // record without who it was issued to.
    expect(REGISTER.applicants?.first_name?.retention).toBe('statutory');
    expect(REGISTER.applicants?.last_name?.retention).toBe('statutory');
  });

  it('marks the login credentials as account-lifetime', () => {
    // Nothing statutory requires keeping a way to authenticate as someone who
    // has left.
    expect(REGISTER.accounts?.email?.retention).toBe('account-lifetime');
    expect(REGISTER.accounts?.password_hash?.retention).toBe('account-lifetime');
    expect(REGISTER.accounts?.mobile_number?.retention).toBe('account-lifetime');
  });

  it('treats a linking id as personal data in its own right', () => {
    // The class people forget. An account id identifies nobody on its own and
    // ties every record here to one person, so erasing a name while keeping the
    // id everywhere leaves a fully linkable trail and an erasure that did not
    // erase.
    expect(REGISTER.accounts?.id?.dataClass).toBe('linkable');
    expect(REGISTER.notifications?.account_id?.dataClass).toBe('linkable');
  });
});
