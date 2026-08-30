import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { TRANSITIONS } from './lifecycle';

/**
 * The seeded rules and the compiled ones agree, exactly.
 *
 * D-5 made the lifecycle editable, which means the TypeScript table stops being
 * the authority and becomes the STARTING POINT. That only works if the two
 * start identical — a seed that quietly differs would change how permits are
 * processed on the day it was applied, and nothing would say so.
 *
 * This gap existed before D-5 as well: `lifecycle_transitions` has always held
 * the graph and the trigger has always enforced it, and nothing ever checked it
 * against the rules the engine applies. `migrator.spec` counted the rows.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

let db: SqlClient;

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
});

afterAll(async () => {
  await db.close();
});

interface Row {
  from_status: string;
  to_status: string;
  actors: string[];
  requires_scope: string;
  preconditions: string[];
  notifies: string | null;
}

const key = (from: string, to: string): string => `${from} -> ${to}`;

describe('the seeded lifecycle matches the compiled one', () => {
  it('has exactly the same moves, neither more nor fewer', async () => {
    const rows = await db.query<Row>('select from_status, to_status from lifecycle_transitions');

    const seeded = new Set(rows.rows.map((row) => key(row.from_status, row.to_status)));
    const compiled = new Set(TRANSITIONS.map((rule) => key(rule.from, rule.to)));

    // Reported as two lists rather than a count, because "one extra and one
    // missing" and "the same table" both produce equal sizes.
    expect([...compiled].filter((move) => !seeded.has(move))).toEqual([]);
    expect([...seeded].filter((move) => !compiled.has(move))).toEqual([]);
  });

  it('carries the same rule on every move', async () => {
    const rows = await db.query<Row>(
      'select from_status, to_status, actors, requires_scope, preconditions, notifies from lifecycle_transitions',
    );
    const byMove = new Map(rows.rows.map((row) => [key(row.from_status, row.to_status), row]));

    const differences: string[] = [];
    for (const rule of TRANSITIONS) {
      const row = byMove.get(key(rule.from, rule.to));
      if (row === undefined) continue;

      if ([...row.actors].sort().join(',') !== [...rule.actors].sort().join(',')) {
        differences.push(`${key(rule.from, rule.to)} actors: ${row.actors.join('|')} vs ${rule.actors.join('|')}`);
      }
      if (row.requires_scope !== rule.requires) {
        differences.push(`${key(rule.from, rule.to)} scope: ${row.requires_scope} vs ${rule.requires}`);
      }
      if ([...row.preconditions].sort().join(',') !== [...rule.preconditions].sort().join(',')) {
        differences.push(
          `${key(rule.from, rule.to)} preconditions: ${row.preconditions.join('|')} vs ${rule.preconditions.join('|')}`,
        );
      }
      if ((row.notifies ?? null) !== (rule.notifies ?? null)) {
        differences.push(`${key(rule.from, rule.to)} notifies: ${row.notifies} vs ${rule.notifies}`);
      }
    }

    expect(differences).toEqual([]);
  });

  it('is seeded in the order the compiled table lists', async () => {
    // `ordinal` is what makes the served workflow read as a process rather than
    // an index, and the seed sets it by hand -- one statement per move, with the
    // position written into it. Inserting a move into the middle of TRANSITIONS
    // without renumbering the migration would shift every move after it, and the
    // only symptom would be a flow chart in a strange order.
    const rows = await db.query<{ from_status: string; to_status: string }>(
      'select from_status, to_status from lifecycle_transitions order by ordinal',
    );

    expect(rows.rows.map((row) => key(row.from_status, row.to_status)))
      .toEqual(TRANSITIONS.map((rule) => key(rule.from, rule.to)));
  });

  it('enumerates enough to mean something', () => {
    // A comparison of two empty sets passes and proves nothing.
    expect(TRANSITIONS.length).toBeGreaterThan(20);
  });
});
