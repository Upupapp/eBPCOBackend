import { join } from 'node:path';

import { loadMigrations, migrate } from '../src/persistence/migrator';
import { PgliteClient } from '../src/persistence/pglite-client';

/**
 * Migration 032 against real PostgreSQL semantics.
 *
 * The backfill is the part worth proving. An empty allow-list fails closed, so
 * a deploy that created these tables without explicitly assigning every serving
 * officer would lock the whole office out of every application — the failure is
 * total, immediate, and only visible in production.
 */

let db: PgliteClient;

const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query<T>(sql, params)).rows;

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
});

afterEach(async () => { await db.close(); });

const staffAccount = async (email: string, roles: string[]): Promise<string> => {
  const [account] = await query<{ id: string }>(
    `insert into accounts (kind, email, email_normalised, password_hash)
     values ('staff', $1, $1, 'scrypt$1$1$1$a$b') returning id`, [email]);
  for (const role of roles) {
    await query('insert into account_roles (account_id, role) values ($1,$2)',
      [account!.id, role]);
  }
  return account!.id;
};

describe('the schema exists and fails closed', () => {
  it('creates the access tables', async () => {
    const tables = await query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`);
    const names = tables.map((row) => row.table_name);

    for (const table of ['staff_access', 'staff_permit_access', 'access_requests',
      'access_request_permit_types', 'access_request_attempts']) {
      expect(names).toContain(table);
    }
  });

  it('gives an unassigned staff account no permit types at all', async () => {
    // Fails closed by construction: there is no row, and no row means nothing.
    const id = await staffAccount('new.officer@castilla.gov.ph', ['evaluator']);

    const granted = await query('select 1 from staff_permit_access where account_id = $1', [id]);
    expect(granted).toEqual([]);
  });

  it('refuses an access level it does not recognise', async () => {
    const id = await staffAccount('x@castilla.gov.ph', ['evaluator']);

    await expect(query(
      'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
      [id, 'view-everything'])).rejects.toThrow();
  });

  it('refuses a permit type that is not a real key', async () => {
    // The allow-list stores INTERNAL keys. A published name — 'Fencing Permit'
    // rather than 'Fencing' — must not be storable, or a display label ends up
    // deciding authorisation.
    const id = await staffAccount('y@castilla.gov.ph', ['evaluator']);

    await expect(query(
      'insert into staff_permit_access (account_id, permit_type, granted_by) values ($1,$2,$1)',
      [id, 'Fencing Permit'])).rejects.toThrow();
  });
});

describe('the backfill assigns every existing officer explicitly', () => {
  /**
   * Applies 001..031, seeds officers as they exist today, then applies 032 —
   * which is the real sequence. Applying everything and inserting afterwards
   * would test a migration against rows it never saw.
   */
  const upToBackfill = async (): Promise<void> => {
    await db.close();
    db = await PgliteClient.create();
    const all = loadMigrations(join(__dirname, '../db/migrations'));
    await migrate(db, all.filter((m) => m.version < 32));

    await staffAccount('acting@castilla.gov.ph', ['evaluator']);
    await staffAccount('reading@castilla.gov.ph', ['auditor']);
    await staffAccount('boss@castilla.gov.ph', ['super-admin']);

    await migrate(db, all);
  };

  it('gives every existing staff account a level', async () => {
    await upToBackfill();

    const unassigned = await query<{ email: string }>(
      `select a.email from accounts a
        where a.kind = 'staff'
          and not exists (select 1 from staff_access s where s.account_id = a.id)`);

    expect(unassigned).toEqual([]);
  });

  it('gives every existing staff account every permit type, preserving today', async () => {
    // The migration must not change behaviour. Today every officer sees every
    // form; the backfill states that in data rather than leaving it implied.
    await upToBackfill();

    const [counts] = await query<{ types: number; granted: number }>(
      `select (select count(*)::int from permit_types) as types,
              (select count(*)::int from staff_permit_access
                where account_id = (select id from accounts where email = 'acting@castilla.gov.ph'))
              as granted`);

    expect(counts!.granted).toBe(counts!.types);
    expect(counts!.granted).toBeGreaterThan(0);
  });

  it('sets the level from the role, matching grantsAuthority', async () => {
    // An acting role becomes view-edit; a read-only one becomes view. That is
    // grantsAuthority() expressed in SQL, and the domain derives the same answer
    // from the function itself, so the two cannot disagree unnoticed.
    await upToBackfill();

    const levels = await query<{ email: string; level: string }>(
      `select a.email, s.level from staff_access s
         join accounts a on a.id = s.account_id order by a.email`);
    const byEmail = Object.fromEntries(levels.map((row) => [row.email, row.level]));

    expect(byEmail['acting@castilla.gov.ph']).toBe('view-edit');
    expect(byEmail['reading@castilla.gov.ph']).toBe('view');
    expect(byEmail['boss@castilla.gov.ph']).toBe('view-edit');
  });

  it('leaves applicants alone', async () => {
    await upToBackfill();
    await query(
      `insert into accounts (kind, email, email_normalised, password_hash)
       values ('applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b')`);

    const assigned = await query(
      `select 1 from staff_access s join accounts a on a.id = s.account_id
        where a.kind = 'applicant'`);

    expect(assigned).toEqual([]);
  });
});

describe('access requests', () => {
  it('allows only one open request per address', async () => {
    // A person may ask again after a refusal; they may not queue five at once.
    const insert = (): Promise<unknown[]> => query(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification)
       values ('Ana Cruz','Ana@Castilla.gov.ph','ana@castilla.gov.ph','09171234567',
               'Engineering Office','view','I evaluate structural plans for the OBO.')`);

    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('lets a refused applicant ask again', async () => {
    // The partial unique index covers PENDING only, so a refusal is not a
    // permanent ban. Someone told "not with that justification" must be able to
    // come back with a better one.
    const decider = await staffAccount('boss@castilla.gov.ph', ['super-admin']);
    await query(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification, status,
                                    decided_at, decided_by, decision_reason)
       values ('Ana Cruz','ana@x.ph','ana@x.ph','0917','Engineering','view',
               'A justification long enough to be a sentence.','rejected', now(), $1,
               'no stated need for this permit type')`, [decider]);

    await query(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification)
       values ('Ana Cruz','ana@x.ph','ana@x.ph','0917','Engineering','view',
               'I evaluate structural plans for the Office of the Building Official.')`);

    const rows = await query('select status from access_requests order by raised_at');
    expect(rows).toHaveLength(2);
  });

  it('refuses a decision that names nobody', async () => {
    // 'It was rejected' is not a decision record.
    await expect(query(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification,
                                    status, decided_at)
       values ('B','b@x.ph','b@x.ph','0917','Engineering','view',
               'A justification long enough to be a sentence.','rejected', now())`),
    ).rejects.toThrow();
  });

  it('refuses a rejection with no reason', async () => {
    const decider = await staffAccount('boss@castilla.gov.ph', ['super-admin']);

    await expect(query(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification,
                                    status, decided_at, decided_by)
       values ('B','b2@x.ph','b2@x.ph','0917','Engineering','view',
               'A justification long enough to be a sentence.','rejected', now(), $1)`,
      [decider]),
    ).rejects.toThrow();
  });

  it('records a requested permit type with no foreign key, so a retired one survives', async () => {
    // Deliberate: a request may name a type that is later retired, or one the
    // requester mistyped. Both must be REVIEWABLE rather than refused at insert
    // by an unauthenticated caller probing which types exist.
    const [request] = await query<{ id: string }>(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification)
       values ('C','c@x.ph','c@x.ph','0917','Engineering','view',
               'A justification long enough to be a sentence.') returning id`);

    await query(
      'insert into access_request_permit_types (request_id, permit_type) values ($1,$2)',
      [request!.id, 'A Type That Was Retired']);

    expect(await query('select 1 from access_request_permit_types')).toHaveLength(1);
  });
});

describe('retirement is a flag, never a delete', () => {
  it('adds retired_at to permit_types', async () => {
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'permit_types'`);

    expect(columns.map((row) => row.column_name)).toContain('retired_at');
  });

  it('refuses to delete a permit type an officer is assigned to', async () => {
    // `on delete restrict`. A grant naming a type has to stay explicable, and a
    // cascade would erase the record of why an officer once had access.
    const id = await staffAccount('officer@castilla.gov.ph', ['evaluator']);
    await query(
      'insert into staff_permit_access (account_id, permit_type, granted_by) values ($1,$2,$1)',
      [id, 'New Construction']);

    await expect(query(
      "delete from permit_types where permit_type = 'New Construction'")).rejects.toThrow();
  });
});
