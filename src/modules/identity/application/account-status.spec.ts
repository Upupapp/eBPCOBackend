import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { AccountStatusReader } from './account-status';

/**
 * Whether the account behind a token is still allowed to act — asked on every
 * authenticated request, because an authorisation decision made from a
 * fifteen-minute-old snapshot is not an authorisation decision.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

let db: SqlClient;
let accounts: AccountStatusReader;
const ACTIVE = randomUUID();
const DISABLED = randomUUID();

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  accounts = new AccountStatusReader(db);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, disabled_at)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b',null),
            ($2,'staff','b@x.ph','b@x.ph','scrypt$1$1$1$a$b',now())`,
    [ACTIVE, DISABLED],
  );
});

afterEach(async () => {
  await db.close();
});

it('reports an account that exists and is allowed to act', async () => {
  expect(await accounts.standingOf(ACTIVE)).toBe('active');
});

it('reports a disabled account as disabled, not as active', async () => {
  expect(await accounts.standingOf(DISABLED)).toBe('disabled');
});

it('reports an account that does not exist as unknown', async () => {
  expect(await accounts.standingOf(randomUUID())).toBe('unknown');
});

it('refuses a malformed subject without touching the database', async () => {
  // A malformed subject in a token that somehow verified should not reach the
  // database at all.
  await db.close();

  expect(await accounts.standingOf("1' or '1'='1")).toBe('unknown');
});

it('does not distinguish unknown from disabled by anything the caller can see', async () => {
  // The two are different states and the guard answers both with 401. This is
  // the assertion that they are at least both refusals — an `unknown` that read
  // as `active` would be the original defect.
  const refused: string[] = ['unknown', 'disabled'];

  expect(refused).toContain(await accounts.standingOf(randomUUID()));
  expect(refused).toContain(await accounts.standingOf(DISABLED));
});
