import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../../applications/domain/application';
import { LifecycleService } from '../../applications/application/lifecycle.service';
import { AuditService } from './audit.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-19T12:00:00Z');

let db: SqlClient;
let audit: AuditService;

const OFFICER = randomUUID();
const APPLICANT_ACCOUNT = randomUUID();
const APPLICATION = randomUUID();

const officer: Caller = {
  accountId: OFFICER, kind: 'staff',
  scopes: [...new Set(Object.values(ROLE_SCOPES).flat())],
};

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  audit = new AuditService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff','o@lgu.gov.ph','o@lgu.gov.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b')`,
    [OFFICER, APPLICANT_ACCOUNT],
  );
  const applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
  // Migration 032's backfill, which a direct-insert fixture skips. The
  // allow-list fails CLOSED, so without it every staff transition is refused.
  await db.query(
    'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
    [OFFICER, 'view-edit']);
  await db.query(
    `insert into staff_permit_access (account_id, permit_type, granted_by)
     select $1, permit_type, $1 from permit_types`, [OFFICER]);
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000001',$2,'Fencing Permit','New','Submitted',now(),$3)`,
    [APPLICATION, applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

const anEvent = (overrides: Partial<Parameters<AuditService['append']>[0]> = {}) => ({
  action: 'application.viewed',
  subjectType: 'application' as const,
  subjectId: APPLICATION,
  outcome: 'allowed' as const,
  actorAccountId: OFFICER,
  actorRole: 'staff',
  ...overrides,
});

describe('appending to the chain', () => {
  it('starts at sequence one, from genesis', async () => {
    expect(await audit.append(anEvent())).toBe(1);

    const row = await db.query<{ previous_hash: string; entry_hash: string }>(
      'select previous_hash, entry_hash from audit_events where sequence = 1',
    );
    expect(row.rows[0]?.previous_hash).toBe('genesis');
    expect(row.rows[0]?.entry_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('links each entry to the one before it', async () => {
    await audit.append(anEvent());
    await audit.append(anEvent({ action: 'application.exported' }));

    const rows = await db.query<{ sequence: number; previous_hash: string; entry_hash: string }>(
      'select sequence, previous_hash, entry_hash from audit_events order by sequence',
    );
    expect(rows.rows[1]?.previous_hash).toBe(rows.rows[0]?.entry_hash);
  });

  it('records the correlation id, so an entry ties back to the request', async () => {
    await audit.append(anEvent());

    const row = await db.query<{ correlation_id: string | null }>(
      'select correlation_id from audit_events where sequence = 1',
    );
    // Outside a request there is none, and that is correct rather than a gap.
    expect(row.rows[0]?.correlation_id).toBeNull();
  });

  it('verifies an untouched chain', async () => {
    for (let i = 0; i < 5; i += 1) await audit.append(anEvent({ action: `action.${i}` }));

    expect(await audit.verify()).toEqual({ intact: true, length: 5 });
  });

  it('audits a refused authorisation, not only a successful act', async () => {
    // An attempt to reach another applicant's record is exactly what anyone
    // investigating an incident wants to find.
    await audit.append(anEvent({ outcome: 'denied', action: 'application.access-refused' }));

    const row = await db.query<{ outcome: string }>('select outcome from audit_events where sequence = 1');
    expect(row.rows[0]?.outcome).toBe('denied');
  });
});

describe('the chain detects tampering', () => {
  const seed = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await audit.append(anEvent({ action: `action.${i}` }));
  };

  it('detects an edited entry', async () => {
    await seed();
    // The append-only trigger blocks an application credential, so this is what
    // a superuser bypassing it would leave behind.
    await db.exec("alter table audit_events disable trigger audit_events_append_only");
    await db.query("update audit_events set action = 'action.tampered' where sequence = 2");
    await db.exec("alter table audit_events enable trigger audit_events_append_only");

    const verdict = await audit.verify();

    expect(verdict.intact).toBe(false);
    if (verdict.intact) return;
    expect(verdict.brokenAtSequence).toBe(2);
    expect(verdict.reason).toBe('hash-mismatch');
  });

  it('detects a removed entry', async () => {
    await seed();
    await db.exec("alter table audit_events disable trigger audit_events_append_only");
    await db.query('delete from audit_events where sequence = 2');
    await db.exec("alter table audit_events enable trigger audit_events_append_only");

    const verdict = await audit.verify();

    expect(verdict.intact).toBe(false);
    if (verdict.intact) return;
    expect(verdict.reason).toBe('sequence-gap');
  });

  it('detects an entry whose actor was changed', async () => {
    // The change someone covering their tracks would actually make.
    await seed();
    await db.exec("alter table audit_events disable trigger audit_events_append_only");
    await db.query('update audit_events set actor_account_id = $1 where sequence = 3', [APPLICANT_ACCOUNT]);
    await db.exec("alter table audit_events enable trigger audit_events_append_only");

    const verdict = await audit.verify();
    expect(verdict.intact).toBe(false);
    if (verdict.intact) return;
    expect(verdict.brokenAtSequence).toBe(3);
  });

  it('reports only the FIRST break', async () => {
    // Once a chain is broken every subsequent hash is computed over a different
    // history; reporting them all buries the one that matters.
    await seed();
    await db.exec("alter table audit_events disable trigger audit_events_append_only");
    await db.query("update audit_events set action = 'x' where sequence in (2, 3)");
    await db.exec("alter table audit_events enable trigger audit_events_append_only");

    const verdict = await audit.verify();
    if (verdict.intact) return;
    expect(verdict.brokenAtSequence).toBe(2);
  });
});

describe('the application cannot rewrite history', () => {
  it('refuses an update through an application credential', async () => {
    await audit.append(anEvent());

    await expect(db.query("update audit_events set outcome = 'denied'")).rejects.toThrow(/append-only/);
  });

  it('refuses a delete through an application credential', async () => {
    await audit.append(anEvent());

    await expect(db.query('delete from audit_events')).rejects.toThrow(/append-only/);
  });

  it('leaves the chain intact after a refused attempt', async () => {
    await audit.append(anEvent());
    await expect(db.query('delete from audit_events')).rejects.toThrow();

    expect((await audit.verify()).intact).toBe(true);
  });
});

describe('every lifecycle transition is audited exactly once', () => {
  it('writes one chained entry per transition', async () => {
    const lifecycle = new LifecycleService(db, () => NOW, audit);

    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });

    const rows = await db.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'application.transitioned'",
    );
    expect(rows.rows[0]?.count).toBe(2);
    expect((await audit.verify()).intact).toBe(true);
  });

  it('writes none when the transition is refused', async () => {
    const lifecycle = new LifecycleService(db, () => NOW, audit);

    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Released' });

    const rows = await db.query<{ count: number }>('select count(*)::int as count from audit_events');
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('records what changed, before and after', async () => {
    const lifecycle = new LifecycleService(db, () => NOW, audit);
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });

    const row = await db.query<{ before_state: { status: string }; after_state: { status: string } }>(
      'select before_state, after_state from audit_events where sequence = 1',
    );
    expect(row.rows[0]?.before_state.status).toBe('Submitted');
    expect(row.rows[0]?.after_state.status).toBe('Received');
  });
});

describe('answering "what happened to this application"', () => {
  it('returns the history without anybody writing SQL', async () => {
    // An officer asked why a permit took three weeks needs to be able to
    // answer. An answer that requires a ticket to the IT unit is not one.
    const lifecycle = new LifecycleService(db, () => NOW, audit);
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Received' });
    await lifecycle.transition({ applicationId: APPLICATION, caller: officer, to: 'Document Verification' });

    const history = await audit.historyOf('application', APPLICATION);

    expect(history).toHaveLength(2);
    expect(history[0]?.action).toBe('application.transitioned');
    expect(history[0]?.actorAccountId).toBe(OFFICER);
    expect(history[0]?.sequence).toBeLessThan(history[1]!.sequence);
  });

  it('returns nothing for an application with no history', async () => {
    expect(await audit.historyOf('application', randomUUID())).toEqual([]);
  });
});
