import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { AuditService } from './audit.service';
import { ERASE_IN_ORDER, ErasureService } from './erasure.service';
import { accountLifetimeColumns } from '../domain/personal-data';

/**
 * "Delete my account", where RA 10173 and PD 1096 disagree.
 *
 * The tests that matter here are the ones about what SURVIVES. Anyone can
 * delete rows; the difficult part is deleting exactly the right ones, being
 * able to prove it, and telling the person honestly what is left.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T03:00:00Z');

let db: SqlClient;
let erasure: ErasureService;

const ACCOUNT = randomUUID();
const OFFICER = randomUUID();
let applicantId: string;
let applicationId: string;

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  erasure = new ErasureService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number)
     values ($1,'applicant','maria.santos@example.ph','maria.santos@example.ph','scrypt$1$1$1$a$b','09171234567'),
            ($2,'staff','officer@lgu.gov.ph','officer@lgu.gov.ph','scrypt$1$1$1$a$b',null)`,
    [ACCOUNT, OFFICER],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, ACCOUNT],
  );
  applicationId = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000041',$2,'Fencing','New','Submitted',now(),$3)`,
    [applicationId, applicantId, ACCOUNT],
  );
  await db.query(
    `insert into notifications (id, account_id, type, application_id, title, body)
     values ($1,$2,'application-submitted',$3,'We have your application','Reference BP-2026-000041')`,
    [randomUUID(), ACCOUNT, applicationId],
  );
  await db.query(
    `insert into devices (id, account_id, platform, push_token_digest, push_token_encrypted)
     values ($1,$2,'android','digest','encrypted')`,
    [randomUUID(), ACCOUNT],
  );
  await db.query(
    `insert into refresh_tokens (id, family_id, account_id, secret_digest, expires_at)
     values ($1,$2,$3,'digest', now() + interval '30 days')`,
    [randomUUID(), randomUUID(), ACCOUNT],
  );
  // One audit entry BEFORE the erasure, so the chain has something to break.
  await new AuditService(db, () => NOW).append({
    action: 'application.submitted',
    subjectType: 'application',
    subjectId: applicationId,
    outcome: 'allowed',
    actorAccountId: ACCOUNT,
  });
});

afterEach(async () => {
  await db.close();
});

const count = async (sql: string, values: unknown[] = []): Promise<number> => {
  const result = await db.query<{ n: string }>(sql, values);
  return Number(result.rows[0]?.n ?? 0);
};

describe('what goes', () => {
  it('removes the notifications, devices and sessions', async () => {
    // Nothing statutory requires keeping a way to reach or authenticate someone
    // who has left.
    await erasure.erase(ACCOUNT);

    expect(await count('select count(*) as n from notifications where account_id = $1', [ACCOUNT])).toBe(0);
    expect(await count('select count(*) as n from devices where account_id = $1', [ACCOUNT])).toBe(0);
    expect(await count('select count(*) as n from refresh_tokens where account_id = $1', [ACCOUNT])).toBe(0);
  });

  it('leaves no contact detail anywhere on the account', async () => {
    await erasure.erase(ACCOUNT);

    const row = await db.query<{ email: string; mobile_number: string | null; password_hash: string }>(
      'select email, mobile_number, password_hash from accounts where id = $1', [ACCOUNT],
    );
    expect(row.rows[0]!.email).not.toContain('maria');
    expect(row.rows[0]!.mobile_number).toBeNull();
    expect(row.rows[0]!.password_hash).toBe('erased');
  });

  it('cannot be signed into afterwards', async () => {
    // An erased account that could still be signed into is not erased.
    await erasure.erase(ACCOUNT);

    const row = await db.query<{ disabled_at: Date | null }>(
      'select disabled_at from accounts where id = $1', [ACCOUNT],
    );
    expect(row.rows[0]!.disabled_at).not.toBeNull();
  });
});

describe('what stays, and why', () => {
  it('keeps the permit application', async () => {
    // PD 1096: a permit is the evidence that a structure was lawfully
    // authorised, and it outlasts the account.
    await erasure.erase(ACCOUNT);

    expect(await count('select count(*) as n from applications where id = $1', [applicationId])).toBe(1);
  });

  it('keeps the name the permit was issued to', async () => {
    // A permit without one is not a record. This is the decision most likely to
    // be got wrong by someone implementing "delete my account".
    await erasure.erase(ACCOUNT);

    const row = await db.query<{ first_name: string }>(
      'select first_name from applicants where id = $1', [applicantId],
    );
    expect(row.rows[0]!.first_name).toBe('Maria');
  });

  it('states no expiry date it cannot support', async () => {
    // The retention schedule is the LGU's to publish (M-15). A plausible date
    // invented here is a commitment made on their behalf that an applicant
    // might rely on. Null with a named basis is the honest answer.
    const result = await erasure.erase(ACCOUNT);

    expect(result.ok && result.receipt.retainedCategories.every((item) => item.until === null)).toBe(true);
  });

  it('names what WAS erased, in words a person reads rather than table names', async () => {
    const result = await erasure.erase(ACCOUNT);

    expect(result.ok && result.receipt.erasedCategories.join(' ')).toMatch(/signed out everywhere/);
  });

  it('tells the person what survives and under which law', async () => {
    // RA 10173 §16(e) is conditional on there being no overriding legal
    // obligation. Naming the obligation is what makes keeping the record lawful
    // rather than merely convenient — and a person is entitled to know.
    const result = await erasure.erase(ACCOUNT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bases = result.receipt.retainedCategories.map((item) => item.basis).join(' ');
    expect(bases).toContain('PD 1096');
    expect(bases).toContain('RA 7160');
    expect(bases).toContain('NPC Circular 16-01');
  });

  it('reports counts rather than a promise', async () => {
    const result = await erasure.erase(ACCOUNT);

    expect(result.ok && result.receipt.counts.notifications).toBe(1);
    expect(result.ok && result.receipt.counts.devices).toBe(1);
  });
});

describe('the audit chain', () => {
  it('still verifies afterwards', async () => {
    // The reason the account row is pseudonymised rather than deleted. The
    // chain hashes actor_account_id into every entry: nulling it would
    // invalidate every entry after, destroying the very evidence that the
    // erasure was carried out.
    await erasure.erase(ACCOUNT);

    const verdict = await new AuditService(db, () => NOW).verify();

    expect(verdict.intact).toBe(true);
  });

  it('records that the erasure happened', async () => {
    await erasure.erase(ACCOUNT);

    expect(await count(
      `select count(*) as n from audit_events where action = 'account.erased' and subject_id = $1`,
      [ACCOUNT],
    )).toBe(1);
  });

  it('keeps the earlier entry that names the erased account', async () => {
    // Deliberate. The id no longer resolves to a person, and the entry is the
    // LGU's evidence of what was done to whose record.
    await erasure.erase(ACCOUNT);

    expect(await count(
      'select count(*) as n from audit_events where actor_account_id = $1', [ACCOUNT],
    )).toBeGreaterThan(0);
  });
});

describe('refusals', () => {
  it('refuses to erase a staff account', async () => {
    // An officer's account attributes decisions on permit records. Removing it
    // would make the record unable to say who approved what, which is the LGU's
    // obligation rather than the officer's choice.
    const result = await erasure.erase(OFFICER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('staff-account');
    expect(result.detail).toMatch(/offboarding/i);
  });

  it('answers not-found for an account that does not exist', async () => {
    const result = await erasure.erase(randomUUID());

    expect(result.ok).toBe(false);
  });
});

describe('asking twice', () => {
  it('answers with the same receipt rather than an error', async () => {
    // Someone asking again is asking for reassurance. "Already done", with the
    // receipt, is the right answer to that.
    const first = await erasure.erase(ACCOUNT);
    const second = await erasure.erase(ACCOUNT);

    expect(second.ok).toBe(true);
    expect(first.ok && second.ok && second.receipt.counts).toEqual(first.ok ? first.receipt.counts : {});
  });

  it('does not write a second erasure entry', async () => {
    await erasure.erase(ACCOUNT);
    await erasure.erase(ACCOUNT);

    expect(await count(
      `select count(*) as n from audit_events where action = 'account.erased'`,
    )).toBe(1);
  });
});

describe('the database enforces the promise, not this service', () => {
  it('refuses an account marked erased that still holds a mobile number', async () => {
    // A service can promise it cleared the contact details. A CHECK constraint
    // means an account marked erased CANNOT still hold them, whatever wrote to
    // it — including a future migration, a fix-up script, or a bug here.
    await erasure.erase(ACCOUNT);

    await expect(
      db.query('update accounts set mobile_number = $2 where id = $1', [ACCOUNT, '09171234567']),
    ).rejects.toThrow();
  });

  it('refuses an account marked erased that still has a real email', async () => {
    await erasure.erase(ACCOUNT);

    await expect(
      db.query('update accounts set email = $2 where id = $1', [ACCOUNT, 'maria@example.ph']),
    ).rejects.toThrow();
  });

  it('refuses an account marked erased that could still be signed into', async () => {
    await erasure.erase(ACCOUNT);

    await expect(
      db.query('update accounts set password_hash = $2 where id = $1', [ACCOUNT, 'scrypt$1$1$1$a$b']),
    ).rejects.toThrow();
  });
});

describe('the deletion list and the register agree', () => {
  it('deletes from every table the register calls account-lifetime', () => {
    // A table added with account-lifetime data and forgotten in the erasure
    // would leave personal data behind after an erasure that reported success.
    const erasedTables = new Set(ERASE_IN_ORDER.map((entry) => entry.table));
    // `accounts` is pseudonymised rather than deleted, and `notifications` is
    // covered through its deliveries; both are handled explicitly.
    erasedTables.add('accounts');

    const missing = [...new Set(accountLifetimeColumns().map((column) => column.table))]
      .filter((table) => !erasedTables.has(table));

    expect(missing).toEqual([]);
  });
});
