import { join } from 'node:path';

import { AuditService } from '../src/modules/compliance/application/audit.service';
import { AccessRequestService } from '../src/modules/identity/application/access-request.service';
import { StaffAccessService } from '../src/modules/identity/application/staff-access.service';
import { StaffDirectoryService } from '../src/modules/identity/application/staff-directory.service';
import { AccessLevel, mayAct, mayWorkOn } from '../src/modules/identity/domain/staff-access';
import { StaffRole, grantsAuthority, scopesFor } from '../src/modules/identity/domain/account';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { PgliteClient } from '../src/persistence/pglite-client';

/**
 * The access-request lifecycle against real PostgreSQL, and the role × level ×
 * forms table.
 *
 * Table-driven because that is what found the last one. The auditor defect — a
 * read-everything-change-nothing role that could move an application through
 * intake — survived because every individual test was written against a caller
 * holding every scope. A table has no such caller.
 */

let db: PgliteClient;
let requests: AccessRequestService;
let access: StaffAccessService;

const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query<T>(sql, params)).rows;

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  const audit = new AuditService(db);
  requests = new AccessRequestService(db, audit);
  access = new StaffAccessService(db, audit);
});

afterEach(async () => { await db.close(); });

const superAdmin = async (email = 'paul@lguids.com.ph'): Promise<string> => {
  const [account] = await query<{ id: string }>(
    `insert into accounts (kind, email, email_normalised, password_hash)
     values ('staff',$1,$1,'scrypt$1$1$1$a$b') returning id`, [email]);
  await query('insert into account_roles (account_id, role) values ($1,$2)',
    [account!.id, 'super-admin']);
  await query('insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [account!.id, 'view-edit']);
  return account!.id;
};

const raise = async (email = 'ana@castilla.gov.ph', permitTypes = ['New Construction']):
Promise<string> => {
  await requests.raise({
    fullName: 'Ana Cruz', email, mobile: '09171234567',
    officePosition: 'Office of the Building Official',
    permitTypes, requestedLevel: 'view-edit',
    justification: 'I evaluate structural plans and need to respond to applicants.',
  }, '203.0.113.10');
  const [row] = await query<{ id: string }>(
    "select id from access_requests where email_normalised = $1 and status = 'pending'", [email]);
  return row!.id;
};

describe('a request never becomes an account by itself', () => {
  it('creates no account when one is raised', async () => {
    await raise();

    const accounts = await query("select 1 from accounts where kind = 'staff'");
    expect(accounts).toEqual([]);
  });

  it('creates no roles, no level and no allow-list', async () => {
    await raise();

    expect(await query('select 1 from account_roles')).toEqual([]);
    expect(await query('select 1 from staff_access')).toEqual([]);
    expect(await query('select 1 from staff_permit_access')).toEqual([]);
  });

  it('records the ask on the security stream with no actor', async () => {
    // Nobody is signed in. Naming an actor would put a falsehood in an
    // append-only chain; the source address is what there is.
    await raise();

    const [entry] = await query<{ action: string; actor_account_id: string | null }>(
      "select action, actor_account_id from audit_events where action = 'access.requested'");

    expect(entry!.action).toBe('access.requested');
    expect(entry!.actor_account_id).toBeNull();
  });
});

describe('the answer is the same whoever asks', () => {
  it('absorbs a second request for the same address without complaint', async () => {
    await raise();
    await raise();

    const open = await query(
      "select 1 from access_requests where email_normalised = 'ana@castilla.gov.ph' and status = 'pending'");
    expect(open).toHaveLength(1);
  });

  it('records an attempt even when the request is absorbed', async () => {
    // The limit counts attempts, not successes. Recording only accepted ones
    // makes it unreachable by the attacker it exists to stop.
    await raise();
    await raise();

    expect(await query('select 1 from access_request_attempts')).toHaveLength(2);
  });

  it('stops recording requests once the address is over its limit', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await requests.raise({
        fullName: 'Ana Cruz', email: `spam${String(attempt)}@x.ph`, mobile: '0917',
        officePosition: 'Engineering', permitTypes: ['New Construction'],
        requestedLevel: 'view',
        justification: 'A justification long enough to pass validation here.',
      }, '198.51.100.7');
    }

    // Ten per IP per hour; six is under it, so all land. The point of this test
    // is the shape: every attempt is recorded whether or not it becomes a
    // request, so the limit can see them.
    expect(await query('select 1 from access_request_attempts')).toHaveLength(6);
  });
});

describe('approval creates the account and its assignment together', () => {
  it('creates account, roles, level and allow-list in one commit', async () => {
    const admin = await superAdmin();
    const id = await raise();

    const result = await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['New Construction', 'Renovation'],
    }, { accountId: admin, role: 'super-admin' });
    expect(result.ok).toBe(true);

    const [created] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ana@castilla.gov.ph'");
    expect(created).toBeDefined();
    expect(await query('select 1 from account_roles where account_id = $1', [created!.id]))
      .toHaveLength(1);
    expect(await query('select 1 from staff_access where account_id = $1', [created!.id]))
      .toHaveLength(1);
    expect(await query('select 1 from staff_permit_access where account_id = $1', [created!.id]))
      .toHaveLength(2);
  });

  it('leaves nothing behind when the assignment cannot be written', async () => {
    // One transaction, never user-first-permissions-later. A permit type that
    // is not a real key fails the foreign key mid-transaction, and the account
    // must not survive it.
    const admin = await superAdmin();
    const id = await raise();

    await expect(requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['Fencing Permit'],
    }, { accountId: admin, role: 'super-admin' })).rejects.toThrow();

    expect(await query("select 1 from accounts where email_normalised = 'ana@castilla.gov.ph'"))
      .toEqual([]);
    const [request] = await query<{ status: string }>(
      'select status from access_requests where id = $1', [id]);
    expect(request!.status).toBe('pending');
  });

  it('refuses an approval with no forms rather than creating a useless account', async () => {
    const admin = await superAdmin();
    const id = await raise();

    const result = await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: [],
    }, { accountId: admin, role: 'super-admin' });

    expect(result.ok).toBe(false);
    expect(await query("select 1 from accounts where kind = 'staff' and email like 'ana%'"))
      .toEqual([]);
  });

  it('creates the account with an unusable password, forcing a reset', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });

    const [created] = await query<{ password_hash: string }>(
      "select password_hash from accounts where email_normalised = 'ana@castilla.gov.ph'");

    // Not a password anyone holds. Forced rotation without a flag someone can
    // forget to set.
    expect(created!.password_hash).not.toBe('');
    expect(created!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('audits the approval with the level and forms granted', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });

    const [entry] = await query<{ actor_account_id: string; after_state: { level: string } }>(
      "select actor_account_id, after_state from audit_events where action = 'access.approved'");

    expect(entry!.actor_account_id).toBe(admin);
    expect(entry!.after_state.level).toBe('view-edit');
  });
});

describe('rejection is attributable and says nothing', () => {
  it('records who refused it and why', async () => {
    const admin = await superAdmin();
    const id = await raise();

    const result = await requests.reject(id, 'no stated need for these permit types',
      { accountId: admin, role: 'super-admin' });
    expect(result.ok).toBe(true);

    const [row] = await query<{ status: string; decided_by: string; decision_reason: string }>(
      'select status, decided_by, decision_reason from access_requests where id = $1', [id]);
    expect(row!.status).toBe('rejected');
    expect(row!.decided_by).toBe(admin);
    expect(row!.decision_reason).toContain('no stated need');
  });

  it('refuses a rejection with no reason', async () => {
    const admin = await superAdmin();
    const id = await raise();

    expect((await requests.reject(id, '  ', { accountId: admin, role: 'super-admin' })).ok)
      .toBe(false);
  });

  it('lets the same person ask again afterwards', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.reject(id, 'not this time', { accountId: admin, role: 'super-admin' });

    await raise();

    expect(await query("select 1 from access_requests where status = 'pending'")).toHaveLength(1);
  });
});

describe('role × level × forms', () => {
  const CASES: {
    role: StaffRole; level: AccessLevel; forms: string[];
    canAct: boolean; reaches: string | null;
  }[] = [
    // The owner's named cases first.
    { role: 'evaluator', level: 'view-edit', forms: [], canAct: true, reaches: null },
    { role: 'auditor', level: 'view', forms: ['New Construction', 'Renovation'],
      canAct: false, reaches: 'New Construction' },
    // And the ordinary ones, so the table is not only edge cases.
    { role: 'evaluator', level: 'view-edit', forms: ['New Construction'],
      canAct: true, reaches: 'New Construction' },
    { role: 'evaluator', level: 'view', forms: ['New Construction'],
      canAct: false, reaches: 'New Construction' },
    { role: 'cashier', level: 'view-edit', forms: ['Renovation'],
      canAct: true, reaches: 'Renovation' },
    { role: 'super-admin', level: 'view-edit', forms: ['New Construction'],
      canAct: true, reaches: 'New Construction' },
  ];

  it.each(CASES)('$role at $level with $forms.length forms',
    async ({ role, level, forms, canAct, reaches }) => {
      const admin = await superAdmin('boss@castilla.gov.ph');
      const [account] = await query<{ id: string }>(
        `insert into accounts (kind, email, email_normalised, password_hash)
         values ('staff','x@castilla.gov.ph','x@castilla.gov.ph','scrypt$1$1$1$a$b')
         returning id`);
      await query('insert into account_roles (account_id, role) values ($1,$2)',
        [account!.id, role]);
      await query('insert into staff_access (account_id, level, assigned_by) values ($1,$2,$3)',
        [account!.id, level, admin]);
      for (const form of forms) {
        await query(
          'insert into staff_permit_access (account_id, permit_type, granted_by) values ($1,$2,$3)',
          [account!.id, form, admin]);
      }

      const granted = await access.accessFor(account!.id);

      expect(mayAct(granted)).toBe(canAct);
      if (reaches === null) {
        expect(granted.permitTypes).toEqual([]);
      } else {
        expect(mayWorkOn(granted, reaches)).toBe(true);
      }
      // And the level never widens the role, whatever the forms say. Read
      // through scopesFor, which is the single place a token's scopes are
      // decided — a second derivation would be the drift this guards against.
      for (const scope of scopesFor({ kind: 'staff', roles: [role] }, level)) {
        if (level === 'view' && scope !== 'profile:read' && scope !== 'profile:write') {
          expect(grantsAuthority(scope)).toBe(false);
        }
      }
    });

  it('keeps an approved request inert when its permit type is later retired', async () => {
    // The owner's third named case. The grant STAYS — it explains why the
    // officer had access — and simply stops matching live work.
    const admin = await superAdmin();
    const id = await raise('ben@castilla.gov.ph', ['Sanitary/Plumbing']);
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['Sanitary/Plumbing'],
    }, { accountId: admin, role: 'super-admin' });
    const [officer] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ben@castilla.gov.ph'");

    await query(
      "update permit_types set retired_at = now() where permit_type = 'Sanitary/Plumbing'");

    // Still recorded...
    expect((await access.accessFor(officer!.id)).permitTypes).toEqual(['Sanitary/Plumbing']);
    // ...and reaching nothing live.
    expect((await access.liveAccessFor(officer!.id)).permitTypes).toEqual([]);
  });
});

// The last-super-admin floor is exercised through the paths that can actually
// remove the role — see 'demoting or disabling the last super admin is refused'
// below. It was briefly tested here through a service method that nothing in
// production called; the reachability gate caught that the rule was built and
// wired to nothing, which is the more useful failure.

describe('changing level and forms is recorded with both sides', () => {
  it('records the level it was and the level it became', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });
    const [officer] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ana@castilla.gov.ph'");

    await access.setLevel(officer!.id, 'view-edit', { accountId: admin, role: 'super-admin' });

    const [entry] = await query<{
      before_state: { level: string }; after_state: { level: string };
    }>("select before_state, after_state from audit_events where action = 'access.level-changed'");

    // 'Ana is now view-edit' is a fact. 'Ana was raised from view to view-edit
    // by Paul' is the answer to the question a reviewer asks.
    expect(entry!.before_state.level).toBe('view');
    expect(entry!.after_state.level).toBe('view-edit');
  });

  it('records the forms before and after a replacement', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });
    const [officer] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ana@castilla.gov.ph'");

    await access.setForms(officer!.id, ['Renovation', 'Demolition'],
      { accountId: admin, role: 'super-admin' });

    const [entry] = await query<{
      before_state: { permitTypes: string[] }; after_state: { permitTypes: string[] };
    }>("select before_state, after_state from audit_events where action = 'access.forms-changed'");

    expect(entry!.before_state.permitTypes).toEqual(['New Construction']);
    expect(entry!.after_state.permitTypes).toEqual(['Demolition', 'Renovation']);
  });

  it('refuses to empty an allow-list, naming the alternative', async () => {
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });
    const [officer] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ana@castilla.gov.ph'");

    const result = await access.setForms(officer!.id, [],
      { accountId: admin, role: 'super-admin' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('disable the account instead');
  });

  it('refuses a permit type that is not a real key, and names it', async () => {
    // A signed-in super admin acting on internal keys is entitled to be told
    // which one was wrong — unlike the anonymous caller at /auth/access-request.
    const admin = await superAdmin();
    const id = await raise();
    await requests.approve(id, {
      roles: ['evaluator'], level: 'view-edit', permitTypes: ['New Construction'],
    }, { accountId: admin, role: 'super-admin' });
    const [officer] = await query<{ id: string }>(
      "select id from accounts where email_normalised = 'ana@castilla.gov.ph'");

    const result = await access.setForms(officer!.id, ['Fencing Permit'],
      { accountId: admin, role: 'super-admin' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('Fencing Permit');
  });
});

describe('demoting or disabling the last super admin is refused', () => {
  /**
   * The floor, reached through the paths a real administrator uses rather than
   * through the domain function directly.
   *
   * The reachability gate caught this: the rule was built, tested and wired to
   * nothing. A test calling `mayRemoveSuperAdmin` proves the arithmetic and
   * says nothing about whether demotion asks it.
   */
  const directory = (): StaffDirectoryService =>
    new StaffDirectoryService(db, new AuditService(db));

  /** A well-formed id that is not the subject. The refusal comes first anyway. */
  const OTHER_ADMIN = '11111111-1111-4111-8111-111111111111';

  it('refuses to demote the only enabled super admin', async () => {
    const only = await superAdmin();

    const result = await directory().setRoles({
      id: only, roles: ['administrator'], actor: OTHER_ADMIN, actorRole: 'super-admin',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('Appoint another super admin first');
    const still = await query<{ n: number }>(
      "select count(*)::int n from account_roles where account_id = $1 and role = 'super-admin'",
      [only]);
    expect(still[0]!.n).toBe(1);
  });

  it('refuses to disable the only enabled super admin', async () => {
    const only = await superAdmin();

    const result = await directory().setDisabled({
      id: only, disabled: true, actor: OTHER_ADMIN, actorRole: 'super-admin',
    });

    expect(result.ok).toBe(false);
    const account = await query<{ disabled_at: Date | null }>(
      'select disabled_at from accounts where id = $1', [only]);
    expect(account[0]!.disabled_at).toBeNull();
  });

  it('permits both once a second super admin exists', async () => {
    // The other half. Without it these pass against a service that refuses
    // every demotion and every disabling.
    //
    // The actor is a REAL account id here, unlike the two refusals above: they
    // never reach the audit write, which is itself confirmation the floor is
    // checked before anything is written.
    const first = await superAdmin('paul@lguids.com.ph');
    const second = await superAdmin('second@castilla.gov.ph');

    expect((await directory().setRoles({
      id: first, roles: ['administrator'], actor: second, actorRole: 'super-admin',
    })).ok).toBe(true);
  });

  it('still permits ENABLING, which can only add an administrator', async () => {
    const first = await superAdmin('paul@lguids.com.ph');
    const second = await superAdmin('second@castilla.gov.ph');
    await query('update accounts set disabled_at = now() where id = $1', [second]);

    // Enabling never removes the last one, so the floor must not block it —
    // and blocking it would make a disabled super admin unrecoverable.
    expect((await directory().setDisabled({
      id: second, disabled: false, actor: first, actorRole: 'super-admin',
    })).ok).toBe(true);
  });
});
