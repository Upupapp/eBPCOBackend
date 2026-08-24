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

describe('a signed-out session', () => {
  const FAMILY = randomUUID();

  it('is refused while the record is live', async () => {
    await db.query(
      `insert into revoked_sessions (family_id, revoked_at, expires_at)
       values ($1, now(), now() + interval '15 minutes')`,
      [FAMILY],
    );

    expect(await accounts.standingOf(ACTIVE, FAMILY)).toBe('session-revoked');
  });

  it('is allowed again once the record has expired, because the token has too', async () => {
    // A revocation record protects nothing after the access tokens it refers to
    // have expired on their own. That is what keeps the table small enough to
    // consult on every request.
    await db.query(
      `insert into revoked_sessions (family_id, revoked_at, expires_at)
       values ($1, now() - interval '1 hour', now() - interval '45 minutes')`,
      [FAMILY],
    );

    expect(await accounts.standingOf(ACTIVE, FAMILY)).toBe('active');
  });

  it('leaves a session nobody signed out alone', async () => {
    // The table records sessions that HAVE been signed out; it is not a
    // register of every session that exists.
    expect(await accounts.standingOf(ACTIVE, randomUUID())).toBe('active');
  });

  it('reports a disabled account as disabled even when the session is also revoked', async () => {
    // The more useful of the two messages. "Your account has been disabled"
    // tells someone what to do; "this session has been signed out" invites them
    // to sign in again and fail.
    await db.query(
      `insert into revoked_sessions (family_id, revoked_at, expires_at)
       values ($1, now(), now() + interval '15 minutes')`,
      [FAMILY],
    );

    expect(await accounts.standingOf(DISABLED, FAMILY)).toBe('disabled');
  });

  it('ignores a malformed session id rather than refusing on it', async () => {
    // A malformed family cannot match a revocation record, and treating it as
    // revoked would refuse a caller for a token defect the account check should
    // decide on.
    expect(await accounts.standingOf(ACTIVE, "1' or '1'='1")).toBe('active');
  });
});
