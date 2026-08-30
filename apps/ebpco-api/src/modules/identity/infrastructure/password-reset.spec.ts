import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { PasswordResetRepository, resetTokenDigest } from '../application/password-reset.repository';
import { InMemoryPasswordResetRepository } from './in-memory-password-reset.repository';
import { PostgresPasswordResetRepository } from './postgres-password-reset.repository';

/**
 * Outstanding password resets, run against BOTH adapters.
 *
 * One contract suite, because the in-memory adapter existing to make tests
 * quick is only useful if it behaves like the real one — and the defect this
 * replaces was precisely an in-memory store that did not.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const NOW = new Date('2026-08-24T09:00:00Z');
const LATER = new Date(NOW.getTime() + 15 * 60_000);

let db: SqlClient;
const ACCOUNT = randomUUID();
const OTHER = randomUUID();

const adapters: { name: string; make: () => PasswordResetRepository }[] = [
  { name: 'in-memory', make: () => new InMemoryPasswordResetRepository() },
  { name: 'postgres', make: () => new PostgresPasswordResetRepository(db) },
];

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','a@x.ph','a@x.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','b@x.ph','b@x.ph','scrypt$1$1$1$a$b')`,
    [ACCOUNT, OTHER],
  );
});

afterEach(async () => {
  await db.close();
});

describe.each(adapters)('$name', ({ make }) => {
  const digest = (token: string): string => resetTokenDigest(token);

  it('redeems a ticket it issued', async () => {
    const tickets = make();
    await tickets.issue(digest('a-token'), ACCOUNT, NOW, LATER);

    const redeemed = await tickets.redeem(digest('a-token'), NOW);

    expect(redeemed?.accountId).toBe(ACCOUNT);
  });

  it('redeems it exactly once', async () => {
    // Two requests arriving together must not both set a password on one
    // account. The check and the mark are one statement.
    const tickets = make();
    await tickets.issue(digest('a-token'), ACCOUNT, NOW, LATER);

    await tickets.redeem(digest('a-token'), NOW);

    expect(await tickets.redeem(digest('a-token'), NOW)).toBeNull();
  });

  it('refuses an expired ticket without consuming it', async () => {
    const tickets = make();
    await tickets.issue(digest('a-token'), ACCOUNT, NOW, LATER);

    expect(await tickets.redeem(digest('a-token'), new Date(LATER.getTime() + 1))).toBeNull();
  });

  it('refuses a token it never issued', async () => {
    expect(await make().redeem(digest('never-issued'), NOW)).toBeNull();
  });

  it('retires an earlier ticket when a new one is issued', async () => {
    // Anyone can start a reset for any address, so an unretired earlier ticket
    // is one somebody else may have triggered and may be holding.
    const tickets = make();
    await tickets.issue(digest('first'), ACCOUNT, NOW, LATER);
    await tickets.issue(digest('second'), ACCOUNT, NOW, LATER);

    expect(await tickets.redeem(digest('first'), NOW)).toBeNull();
    expect(await tickets.redeem(digest('second'), NOW)).not.toBeNull();
  });

  it('does not retire another account’s ticket', async () => {
    const tickets = make();
    await tickets.issue(digest('mine'), ACCOUNT, NOW, LATER);
    await tickets.issue(digest('theirs'), OTHER, NOW, LATER);

    expect(await tickets.redeem(digest('mine'), NOW)).not.toBeNull();
  });
});

describe('what is stored', () => {
  it('is the digest, never the token', async () => {
    // The table stores a digest on purpose: a leak of this store must not hand
    // over working reset links. The Map this replaces was keyed by the raw
    // token, which threw that property away.
    await new PostgresPasswordResetRepository(db).issue(
      resetTokenDigest('the-secret-token'), ACCOUNT, NOW, LATER,
    );

    const rows = await db.query<{ token_digest: string }>(
      'select token_digest from password_reset_tickets',
    );
    expect(rows.rows[0]!.token_digest).not.toContain('the-secret-token');
    expect(rows.rows[0]!.token_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('survives a restart, which the Map did not', async () => {
    // Password reset did not work behind more than one replica: the applicant
    // asked on one instance and clicked a link that reached another, which had
    // never heard of the ticket.
    await new PostgresPasswordResetRepository(db).issue(digestOf('a-token'), ACCOUNT, NOW, LATER);

    // A different instance, sharing only the database.
    const otherInstance = new PostgresPasswordResetRepository(db);

    expect(await otherInstance.redeem(digestOf('a-token'), NOW)).not.toBeNull();
  });
});

function digestOf(token: string): string {
  return resetTokenDigest(token);
}
