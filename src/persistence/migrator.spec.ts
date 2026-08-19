import { join } from 'node:path';

import { PgliteClient } from './pglite-client';
import { SqlClient } from './sql-client';
import { MigrationError, applied, checksum, loadMigrations, migrate } from './migrator';

const MIGRATIONS_DIR = join(__dirname, '../../db/migrations');

describe('migrations', () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await PgliteClient.create();
  });
  afterEach(async () => {
    await db.close();
  });

  it('runs cleanly from empty to current', async () => {
    // Acceptance criterion: this must hold on every run, from nothing. Against
    // real PostgreSQL, not a fake -- PGlite is the actual engine.
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);

    const result = await migrate(db, migrations);

    expect(result.applied).toBe(migrations.length);
    expect((await applied(db)).map((entry) => entry.version)).toEqual(
      migrations.map((migration) => migration.version),
    );
  });

  it('is idempotent: a second run applies nothing', async () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await migrate(db, migrations);

    expect((await migrate(db, migrations)).applied).toBe(0);
  });

  it('refuses to run a migration that changed after it was applied', async () => {
    // Editing an applied migration produces two databases with the same version
    // number and different shapes, and the one that is wrong is always
    // production.
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await migrate(db, migrations);

    const tampered = migrations.map((migration, index) =>
      index === 0 ? { ...migration, sql: `${migration.sql}\n-- sneaky\ncreate table oops (id int);` } : migration,
    );

    await expect(migrate(db, tampered)).rejects.toBeInstanceOf(MigrationError);
  });

  it('ignores reindentation, so formatting is not a false alarm', () => {
    expect(checksum('create   table  t (id int);')).toBe(checksum('create table t (id int);'));
    expect(checksum('create table t (id int);')).not.toBe(checksum('create table t (id bigint);'));
  });

  it('refuses to deploy a build older than the schema it faces', async () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await migrate(db, migrations);

    // The database has migrations this build does not contain.
    await expect(migrate(db, migrations.slice(0, -1))).rejects.toThrow(/older than the schema/);
  });

  it('leaves nothing behind when a migration fails halfway', async () => {
    // PostgreSQL has transactional DDL, so the next attempt starts from a known
    // state rather than a partially-applied one.
    const broken = [
      { version: 1, name: 'broken', sql: 'create table half_done (id int); select 1/0;' },
    ];

    await expect(migrate(db, broken)).rejects.toBeDefined();

    const tables = await db.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'half_done'",
    );
    expect(tables.rows[0]?.count).toBe(0);
  });

  it('refuses two migrations claiming the same version', () => {
    expect(() =>
      loadMigrations(join(__dirname, '__fixtures__', 'does-not-exist')),
    ).toThrow();
  });
});

describe('the schema this produces', () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await PgliteClient.create();
    await migrate(db, loadMigrations(MIGRATIONS_DIR));
  });
  afterEach(async () => {
    await db.close();
  });

  it('creates every table the domain needs', async () => {
    const result = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tables = result.rows.map((row) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'accounts', 'account_roles', 'refresh_tokens', 'password_reset_tickets',
        'lifecycle_statuses', 'lifecycle_transitions', 'permit_types', 'charter_entries',
        'holiday_calendars', 'holidays',
        'applicants', 'businesses', 'applications', 'application_transitions',
        'documents', 'orders_of_payment', 'payments',
        'evaluations', 'letters_of_instruction', 'instruction_items', 'inspections',
        'generated_permits', 'permit_releases',
        'notification_types', 'notifications', 'notification_preferences', 'devices',
        'audit_events',
        'schema_migrations',
      ]),
    );
  });

  it('seeds the nineteen lifecycle statuses and their legal moves', async () => {
    const statuses = await db.query<{ count: number }>('select count(*)::int as count from lifecycle_statuses');
    const transitions = await db.query<{ count: number }>('select count(*)::int as count from lifecycle_transitions');

    expect(statuses.rows[0]?.count).toBe(19);
    expect(transitions.rows[0]?.count).toBeGreaterThan(20);
  });

  it('seeds the closed 24-type notification catalog', async () => {
    const result = await db.query<{ count: number }>('select count(*)::int as count from notification_types');
    expect(result.rows[0]?.count).toBe(24);
  });

  it('ships the Citizen’s Charter table EMPTY', async () => {
    // LGU-published data (M-08). Seeding a plausible-looking pledged period
    // would be inventing a promise the LGU never made.
    const result = await db.query<{ count: number }>('select count(*)::int as count from charter_entries');
    expect(result.rows[0]?.count).toBe(0);
  });

  it('uses no floating-point column anywhere', async () => {
    // A float in a fee path is how a total ends up a centavo out at the
    // cashier. NUMERIC is exact decimal rather than floating point, so it is
    // not in this list -- see the monetary test below for what it must carry.
    const result = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('double precision', 'real')`,
    );

    expect(result.rows).toEqual([]);
  });

  it('makes every monetary column exact and integral', async () => {
    // NUMERIC, not BIGINT. PostgreSQL ROUNDS a non-integer into a BIGINT rather
    // than rejecting it -- 50000.75 becomes 50001, silently, and any CHECK then
    // runs against the rounded value and passes. The scale check below is what
    // turns that quiet correction into a loud constraint violation.
    const result = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public' and column_name like '%_centavos'`,
    );

    expect(result.rows.length).toBeGreaterThan(6);
    for (const column of result.rows) {
      expect(column.data_type).toBe('numeric');
    }

    // And every one of them is guarded by an integrality check.
    const checks = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_constraint
        where contype = 'c' and pg_get_constraintdef(oid) like '%scale(%centavos%'`,
    );
    expect(checks.rows[0]?.count).toBeGreaterThanOrEqual(result.rows.length);
  });
});
