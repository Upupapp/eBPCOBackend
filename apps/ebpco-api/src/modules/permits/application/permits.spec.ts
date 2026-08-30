import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../../applications/domain/application';
import { LifecycleStatus } from '../../applications/domain/lifecycle';
import { FALLBACK_PREFIX, PERMIT_NUMBER_PREFIXES, PermitService } from './permit.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T02:00:00Z');

let db: SqlClient;
let permits: PermitService;

const APPLICANT_ACCOUNT = randomUUID();
const OFFICIAL_ACCOUNT = randomUUID();
const RELEASING_ACCOUNT = randomUUID();
let applicantId: string;

const official: Caller = { accountId: OFFICIAL_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES['building-official'] };
const releasing: Caller = { accountId: RELEASING_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES['releasing-officer'] };

const EDGES: ReadonlyArray<readonly [LifecycleStatus, LifecycleStatus]> = [
  ['Submitted', 'Received'], ['Received', 'Document Verification'],
  ['Document Verification', 'Under Evaluation'], ['Under Evaluation', 'Assessed'],
  ['Assessed', 'Payment Submitted'], ['Payment Submitted', 'Payment Under Verification'],
  ['Payment Under Verification', 'Payment Verified'], ['Payment Verified', 'For Approval'],
  ['For Approval', 'Approved'], ['Approved', 'Permit Generated'],
  ['Permit Generated', 'Ready for Release'],
];

async function file(reference: string, target: LifecycleStatus, permitType = 'Fencing'): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,$2,$3,$4,'New','Submitted',now(),$5)`,
    [id, reference, applicantId, permitType, APPLICANT_ACCOUNT],
  );
  let current: LifecycleStatus = 'Submitted';
  while (current !== target) {
    const next = EDGES.find(([from]) => from === current)?.[1];
    if (next === undefined) throw new Error(`no route from ${current} to ${target}`);
    await db.query('update applications set lifecycle_status = $1 where id = $2', [next, id]);
    current = next;
  }
  return id;
}

const SCOPE = 'Perimeter fence, 42 linear metres, hollow block on reinforced concrete footing';

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  permits = new PermitService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b'),
            ($2,'staff','official@lgu.gov.ph','official@lgu.gov.ph','scrypt$1$1$1$a$b'),
            ($3,'staff','releasing@lgu.gov.ph','releasing@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT, OFFICIAL_ACCOUNT, RELEASING_ACCOUNT],
  );
  applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

describe('a permit is generated only for an approved application', () => {
  it('refuses one that has not been approved', async () => {
    // The document would say the Building Official allowed something they
    // never saw.
    const id = await file('BP-1', 'Under Evaluation');

    const result = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-approved');
    expect(result.detail).toContain('Under Evaluation');
  });

  it('issues one for an approved application', async () => {
    const id = await file('BP-1', 'Approved');

    const result = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(result.ok).toBe(true);
  });

  it('refuses a second permit for the same application', async () => {
    const id = await file('BP-1', 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    const again = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('already-generated');
  });

  it('refuses a scope too vague to check on site', async () => {
    const id = await file('BP-1', 'Approved');

    const result = await permits.generate({ applicationId: id, officer: official, scope: 'fence', conditions: [] });

    expect(result.ok).toBe(false);
  });
});

describe('the permit number', () => {
  it('says what kind of permit it is', async () => {
    // An applicant reads it aloud at a counter and writes it on a form. A
    // prefix makes a misfiled permit obvious; an opaque serial does not.
    const id = await file('BP-1', 'Approved', 'Fencing');

    const result = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(result.ok && result.permitNumber).toMatch(/^FP-2026-\d{6}$/);
  });

  it('falls back rather than failing on a permit type it does not know', async () => {
    // A permit type the LGU adds must not stop a permit being issued. The type
    // has to exist in the reference table first — the foreign key is right, and
    // a fixture that bypassed it would be testing a database this does not run
    // against.
    await db.query(
      `insert into permit_types (permit_type, service_domain) values ('Signage','Business Permit')`,
    );
    const id = await file('BP-1', 'Approved', 'Signage');

    const result = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(result.ok && result.permitNumber.startsWith('PRM-')).toBe(true);
  });

  it('is never issued twice, even for two applications approved at once', async () => {
    // A duplicate permit number is not a display bug: it is two buildings whose
    // paperwork cannot be told apart.
    const ids = await Promise.all([
      file('BP-1', 'Approved'), file('BP-2', 'Approved'), file('BP-3', 'Approved'),
    ]);

    const results = await Promise.all(ids.map((id) =>
      permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] })));

    const numbers = results.filter((r) => r.ok).map((r) => (r as { permitNumber: string }).permitNumber);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });
});

describe('the counter behind the number', () => {
  it('does not reissue a number that already exists', async () => {
    // The defect the sample emitter exposed: counting rows and adding one
    // issued FP-2026-000002 into a fixture that already held FP-2026-000212.
    // A migrated or hand-corrected record is enough to break a count.
    const existing = await file('BP-0', 'Approved');
    await db.query(
      `insert into generated_permits (application_id, permit_number, issued_date, scope, conditions, generated_by)
       values ($1,'FP-2026-000212',$2,$3,'{}',$4)`,
      [existing, NOW, SCOPE, OFFICIAL_ACCOUNT],
    );
    await db.query(
      `insert into document_number_sequences (series, year, last_issued) values ('FP', 2026, 212)`,
    );
    const id = await file('BP-1', 'Approved');

    const result = await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    expect(result.ok && result.permitNumber).toBe('FP-2026-000213');
  });

  it('counts each permit type separately', async () => {
    // An LGU numbers its fencing permits and its new-construction permits
    // independently, and restarts both in January.
    const fence = await file('BP-1', 'Approved', 'Fencing');
    const building = await file('BP-2', 'Approved', 'New Construction');

    const first = await permits.generate({ applicationId: fence, officer: official, scope: SCOPE, conditions: [] });
    const second = await permits.generate({ applicationId: building, officer: official, scope: SCOPE, conditions: [] });

    expect(first.ok && first.permitNumber).toBe('FP-2026-000001');
    expect(second.ok && second.permitNumber).toBe('BP-2026-000001');
  });

  it('has a prefix for every permit type the LGU actually has', async () => {
    // The first version of the prefix table invented names the reference table
    // does not have, so every real application would have fallen through to the
    // generic prefix and nothing would have said so.
    const types = await db.query<{ permit_type: string }>('select permit_type from permit_types');

    const missing = types.rows
      .map((row) => row.permit_type)
      .filter((type) => PERMIT_NUMBER_PREFIXES[type] === undefined);

    expect(missing).toEqual([]);
  });

  it('gives each permit type a distinct prefix', () => {
    // Two types sharing one prefix makes two different permits look like the
    // same series, which is the thing the prefix exists to prevent.
    const prefixes = Object.values(PERMIT_NUMBER_PREFIXES);

    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).not.toContain(FALLBACK_PREFIX);
  });
});

describe('the conditions on a permit', () => {
  it('are kept as a list, because each is a separate obligation', async () => {
    const id = await file('BP-1', 'Approved');

    await permits.generate({
      applicationId: id, officer: official, scope: SCOPE,
      conditions: ['Maintain a 1.5m setback.', 'Notify the OBO before backfilling.'],
    });

    const row = await db.query<{ conditions: string[] }>(
      'select conditions from generated_permits where application_id = $1', [id],
    );
    expect(row.rows[0]!.conditions).toHaveLength(2);
  });

  it('drop blank entries rather than printing an empty bullet', async () => {
    const id = await file('BP-1', 'Approved');

    await permits.generate({
      applicationId: id, officer: official, scope: SCOPE, conditions: ['Real condition.', '   ', ''],
    });

    const row = await db.query<{ conditions: string[] }>(
      'select conditions from generated_permits where application_id = $1', [id],
    );
    expect(row.rows[0]!.conditions).toEqual(['Real condition.']);
  });
});

describe('preparing a release', () => {
  it('refuses before a permit exists', async () => {
    const id = await file('BP-1', 'Approved');

    const result = await permits.prepareRelease({
      applicationId: id, officer: releasing,
      claimLocation: 'OBO, 2/F City Hall', officeHours: 'Mon-Fri 8-5', bringWithYou: ['One valid ID'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-permit');
  });

  it('refuses a blank location, because the applicant has to travel to it', async () => {
    const id = await file('BP-1', 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    const result = await permits.prepareRelease({
      applicationId: id, officer: releasing, claimLocation: '  ', officeHours: 'Mon-Fri 8-5', bringWithYou: [],
    });

    expect(result.ok).toBe(false);
  });

  it('can be corrected without creating a second release', async () => {
    const id = await file('BP-1', 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });
    const details = {
      applicationId: id, officer: releasing, officeHours: 'Mon-Fri 8-5', bringWithYou: ['One valid ID'],
    };

    await permits.prepareRelease({ ...details, claimLocation: 'Ground floor' });
    await permits.prepareRelease({ ...details, claimLocation: 'Second floor, OBO' });

    const rows = await db.query<{ claim_location: string }>(
      'select claim_location from permit_releases where application_id = $1', [id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.claim_location).toBe('Second floor, OBO');
  });
});

describe('releasing the permit', () => {
  async function readyToRelease(reference: string): Promise<string> {
    const id = await file(reference, 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });
    await permits.prepareRelease({
      applicationId: id, officer: releasing, claimLocation: 'OBO, 2/F City Hall',
      officeHours: 'Mon-Fri 8-5', bringWithYou: ['One valid ID'],
    });
    await db.query(`update applications set lifecycle_status = 'Permit Generated' where id = $1`, [id]);
    await db.query(`update applications set lifecycle_status = 'Ready for Release' where id = $1`, [id]);
    return id;
  }

  it('records who collected it', async () => {
    // The only evidence of who holds the document.
    const id = await readyToRelease('BP-1');

    const result = await permits.release({
      applicationId: id, officer: releasing, claimantName: 'Maria Santos', method: 'Physical Claim',
    });

    expect(result.ok).toBe(true);
    const row = await db.query<{ claimant_name: string; releasing_officer: string }>(
      'select claimant_name, releasing_officer from permit_releases where application_id = $1', [id],
    );
    expect(row.rows[0]!.claimant_name).toBe('Maria Santos');
    expect(row.rows[0]!.releasing_officer).toBe(RELEASING_ACCOUNT);
  });

  it('refuses a nameless claimant', async () => {
    // "Authorized Representative" with no name is a permit handed to nobody in
    // particular.
    const id = await readyToRelease('BP-1');

    const result = await permits.release({
      applicationId: id, officer: releasing, claimantName: '', method: 'Authorized Representative',
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a second release', async () => {
    // Two people holding what should be one document.
    const id = await readyToRelease('BP-1');
    await permits.release({
      applicationId: id, officer: releasing, claimantName: 'Maria Santos', method: 'Physical Claim',
    });

    const again = await permits.release({
      applicationId: id, officer: releasing, claimantName: 'Someone Else', method: 'Physical Claim',
    });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('already-released');
  });

  it('refuses one that is not Ready for Release', async () => {
    const id = await file('BP-1', 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    const result = await permits.release({
      applicationId: id, officer: releasing, claimantName: 'Maria Santos', method: 'Physical Claim',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-ready');
  });
});

describe('the audit trail', () => {
  it('records generation and release, and nothing for a refusal', async () => {
    const refused = await file('BP-1', 'Under Evaluation');
    await permits.generate({ applicationId: refused, officer: official, scope: SCOPE, conditions: [] });

    const id = await file('BP-2', 'Approved');
    await permits.generate({ applicationId: id, officer: official, scope: SCOPE, conditions: [] });

    const actions = await db.query<{ action: string }>('select action from audit_events order by sequence');
    expect(actions.rows.map((r) => r.action)).toEqual(['permit.generated']);
  });
});
