import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import { Caller } from '../domain/application';
import { EVALUATION_STAGES, EvaluationService } from './evaluation.service';

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-20T02:00:00Z');

let db: SqlClient;
let evaluations: EvaluationService;

const APPLICANT_ACCOUNT = randomUUID();
const EVALUATOR_ACCOUNT = randomUUID();
const APPLICATION = randomUUID();

const evaluator: Caller = { accountId: EVALUATOR_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES.evaluator };

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  evaluations = new EvaluationService(db, () => NOW);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b'),
            ($2,'staff','evaluator@lgu.gov.ph','evaluator@lgu.gov.ph','scrypt$1$1$1$a$b')`,
    [APPLICANT_ACCOUNT, EVALUATOR_ACCOUNT],
  );
  const applicantId = randomUUID();
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicantId, APPLICANT_ACCOUNT],
  );
  await db.query(
    `insert into applications (id, reference_number, applicant_id, permit_type, application_action,
                               lifecycle_status, submitted_at, created_by)
     values ($1,'BP-2026-000001',$2,'Fencing','New','Submitted',now(),$3)`,
    [APPLICATION, applicantId, APPLICANT_ACCOUNT],
  );
});

afterEach(async () => {
  await db.close();
});

const pass = (stage: (typeof EVALUATION_STAGES)[number]) =>
  evaluations.record({ applicationId: APPLICATION, stage, result: 'Passed', evaluator });

describe('an adverse result must be actionable', () => {
  it('refuses Revision Required with no remarks', async () => {
    // An applicant told "Revision Required" and nothing else has a deadline
    // they cannot meet, because they do not know what to do.
    const result = await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Revision Required', evaluator,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('remarks-required');
  });

  it('refuses remarks too short to say anything', async () => {
    const result = await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Rejected', evaluator, remarks: 'no',
    });

    expect(result.ok).toBe(false);
  });

  it('accepts a passing result with none, because there is nothing to fix', async () => {
    expect((await pass('Initial')).ok).toBe(true);
  });

  it('keeps the remarks verbatim', async () => {
    // Never summarised: a paraphrase of "sheet S-3 is unsigned" is not
    // actionable.
    const verbatim = 'Sheet S-3 is unsigned by the structural engineer, and sheet A-2 has no scale bar.';
    await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Revision Required', evaluator, remarks: verbatim,
    });

    expect((await evaluations.of(APPLICATION))[0]!.remarks).toBe(verbatim);
  });
});

describe('a stage is decided once', () => {
  it('refuses to overwrite a decision the applicant may already have seen', async () => {
    // Silently replacing it leaves a record that no longer matches what they
    // were told. The honest correction is a new evaluation cycle.
    await pass('Initial');

    const again = await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Rejected', evaluator,
      remarks: 'On reflection this does not conform.',
    });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('already-decided');
  });
});

describe('the stages are worked in order', () => {
  it('refuses a later stage before an earlier one, and says which is next', async () => {
    // Fire Safety examines a plan the OBO has not structurally checked. Passing
    // it first produces a record saying an application was cleared on evidence
    // nobody had.
    const result = await evaluations.record({
      applicationId: APPLICATION, stage: 'Fire Safety', result: 'Passed', evaluator,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-order');
    expect(result.detail).toContain('Initial');
  });

  it('accepts each stage in turn', async () => {
    for (const stage of EVALUATION_STAGES) {
      expect((await pass(stage)).ok).toBe(true);
    }
  });
});

describe('completeness, which the lifecycle asks about', () => {
  it('is false until every stage is decided', async () => {
    for (const stage of EVALUATION_STAGES.slice(0, 4)) {
      const result = await pass(stage);
      expect(result.ok && result.complete).toBe(false);
    }
  });

  it('is true on the last one', async () => {
    for (const stage of EVALUATION_STAGES.slice(0, 4)) await pass(stage);

    const last = await pass('Final Approval');

    expect(last.ok && last.complete).toBe(true);
  });

  it('makes the lifecycle precondition answerable at all', async () => {
    // Before this service existed there was no way to write an evaluation row,
    // so `evaluations-complete` could only ever be false and two transitions
    // that require it were unreachable by anyone.
    for (const stage of EVALUATION_STAGES) await pass(stage);

    const rows = await db.query<{ n: string }>(
      `select count(*) as n from evaluations where application_id = $1 and result <> 'Pending'`,
      [APPLICATION],
    );
    expect(Number(rows.rows[0]!.n)).toBe(EVALUATION_STAGES.length);
  });
});

describe('separation of duty', () => {
  it('refuses an officer evaluating their own application', async () => {
    // Not hypothetical: staff apply for permits on their own houses.
    const self: Caller = { accountId: APPLICANT_ACCOUNT, kind: 'staff', scopes: ROLE_SCOPES.evaluator };

    const result = await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Passed', evaluator: self,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('self-review');
  });
});

describe('an evaluation is attributable', () => {
  it('records who decided it and when', async () => {
    await pass('Initial');

    const row = await db.query<{ evaluator_id: string; evaluated_at: Date }>(
      'select evaluator_id, evaluated_at from evaluations where application_id = $1',
      [APPLICATION],
    );
    expect(row.rows[0]!.evaluator_id).toBe(EVALUATOR_ACCOUNT);
    expect(row.rows[0]!.evaluated_at).not.toBeNull();
  });

  it('writes an audit entry carrying the remarks', async () => {
    // The audit entry is what survives if the evaluation is ever superseded.
    await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Revision Required', evaluator,
      remarks: 'The lot plan is not signed by a geodetic engineer.',
    });

    const audit = await db.query<{ after_state: { remarks: string } }>(
      `select after_state from audit_events where action = 'evaluation.recorded'`,
    );
    expect(audit.rows[0]!.after_state.remarks).toContain('geodetic engineer');
  });

  it('leaves nothing behind when the evaluation is refused', async () => {
    // The audit write is inside the transaction; a refused evaluation must not
    // leave an entry saying one happened.
    await evaluations.record({
      applicationId: APPLICATION, stage: 'Fire Safety', result: 'Passed', evaluator,
    });

    const audit = await db.query<{ n: string }>('select count(*) as n from audit_events');
    expect(Number(audit.rows[0]!.n)).toBe(0);
  });
});

describe('the applicant is told when a stage passes', () => {
  // `evaluation-stage-passed` sat in the catalog with copy, a category and a
  // deep link, and nothing ever wrote it. The only writer of notifications was
  // the lifecycle transition table, and an evaluation is not a transition — so
  // an applicant watching their application saw stages clear in silence.

  const notices = async (): Promise<Array<{ type: string; deep_link: string | null }>> =>
    (await db.query<{ type: string; deep_link: string | null }>(
      'select type, deep_link from notifications order by created_at',
    )).rows;

  it('writes exactly one notice for a passed stage', async () => {
    await pass('Initial');

    expect(await notices()).toEqual([
      { type: 'evaluation-stage-passed', deep_link: `/applications/${APPLICATION}` },
    ]);
  });

  it('writes one per passed stage, not one for the set', async () => {
    await pass('Initial');
    await pass('Zoning');

    expect((await notices()).map((n) => n.type)).toEqual([
      'evaluation-stage-passed', 'evaluation-stage-passed',
    ]);
  });

  it('says NOTHING for an adverse result', async () => {
    // Deliberate. Revision Required and Rejected are followed by a lifecycle
    // move that notifies with the remarks telling the applicant what to do. A
    // notice fired from here would duplicate that, or — if the officer never
    // makes the move — announce a refusal the application has not received.
    await evaluations.record({
      applicationId: APPLICATION, stage: 'Initial', result: 'Revision Required', evaluator,
      remarks: 'The lot plan is not signed by a geodetic engineer.',
    });

    expect(await notices()).toEqual([]);
  });

  it('leaves no notice behind when the evaluation is refused', async () => {
    // Same transaction as the evaluation row, for the same reason the audit
    // entry is: a notice for something that then rolls back tells an applicant
    // their stage cleared when it did not.
    const refused = await evaluations.record({
      applicationId: APPLICATION, stage: 'Fire Safety', result: 'Passed', evaluator,
    });

    expect(refused.ok).toBe(false);
    expect(await notices()).toEqual([]);
  });

  it('addresses the notice to the applicant, not the evaluator', async () => {
    await pass('Initial');

    const to = await db.query<{ account_id: string }>('select account_id from notifications');
    expect(to.rows[0]?.account_id).toBe(APPLICANT_ACCOUNT);
    expect(to.rows[0]?.account_id).not.toBe(EVALUATOR_ACCOUNT);
  });
});
