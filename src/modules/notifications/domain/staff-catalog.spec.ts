import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { STAFF_NOTICE_TYPES } from './staff-catalog';

/**
 * The seeded staff notice types and the compiled ones agree, exactly.
 *
 * `staff_notifications.type` is a foreign key, so a code path emitting a type
 * the migration never inserted fails at INSERT time -- in production, inside
 * the transaction carrying someone's status change. The same shape of gate as
 * `transition-seed.spec`, for the same reason: two lists that must be identical
 * and nothing else comparing them.
 */

let db: SqlClient;

beforeAll(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../../../../db/migrations')));
});

afterAll(async () => {
  await db.close();
});

it('seeds exactly the staff notice types the code can emit', async () => {
  const rows = await db.query<{ type: string; requires_act: boolean }>(
    'select type, requires_act from staff_notification_types order by type',
  );

  expect(rows.rows).toEqual(
    [...STAFF_NOTICE_TYPES]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((entry) => ({ type: entry.type, requires_act: entry.requiresAct })),
  );
});
