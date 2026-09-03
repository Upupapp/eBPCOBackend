import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AccountRepository } from '../application/account.repository';
import { SessionRepository } from '../application/session.repository';
import { Account } from '../domain/account';
import { StoredRefreshToken } from '../domain/tokens';
import { InMemoryAccountRepository } from './in-memory-account.repository';
import { InMemorySessionRepository } from './in-memory-session.repository';
import { PostgresAccountRepository } from './postgres-account.repository';
import { PostgresSessionRepository } from './postgres-session.repository';
import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';

/**
 * One suite, both adapters.
 *
 * The in-memory repositories are what every unit test and the mock build run
 * against; PostgreSQL is what production runs against. If those two disagree
 * about anything -- and they will, given `on conflict`, type coercion, and null
 * handling -- the disagreement surfaces as a failing test here rather than as
 * an incident on the day the mock build is switched off.
 *
 * The PostgreSQL half runs against real PostgreSQL, in-process, via PGlite.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');

interface Harness {
  accounts: AccountRepository;
  sessions: SessionRepository;
  teardown(): Promise<void>;
}

const implementations: Array<[string, () => Promise<Harness>]> = [
  [
    'in-memory',
    () =>
      Promise.resolve({
        accounts: new InMemoryAccountRepository(),
        sessions: new InMemorySessionRepository(),
        teardown: () => Promise.resolve(),
      }),
  ],
  [
    'PostgreSQL',
    async () => {
      const db: SqlClient = await PgliteClient.create();
      await migrate(db, loadMigrations(MIGRATIONS_DIR));
      return {
        accounts: new PostgresAccountRepository(db),
        sessions: new PostgresSessionRepository(db),
        teardown: () => db.close(),
      };
    },
  ],
];

const anAccount = (overrides: Partial<Account> = {}): Account => ({
  id: randomUUID(),
  kind: 'applicant',
  fullName: null,
  email: `applicant-${randomUUID().slice(0, 8)}@example.ph`,
  passwordHash: 'scrypt$1024$8$1$c2FsdA$aGFzaA',
  roles: [],
  emailVerifiedAt: null,
  mobileVerifiedAt: null,
  totpSecret: null,
  disabledAt: null,
  createdAt: new Date('2026-08-19T12:00:00Z'),
  ...overrides,
});

const aToken = (accountId: string, overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken => ({
  id: randomUUID(),
  familyId: randomUUID(),
  accountId,
  secretDigest: 'digest-of-a-secret',
  issuedAt: new Date('2026-08-19T12:00:00Z'),
  expiresAt: new Date('2026-09-19T12:00:00Z'),
  consumedAt: null,
  revokedAt: null,
  ...overrides,
});

describe.each(implementations)('%s repositories', (_name, create) => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await create();
  });
  afterEach(async () => {
    await harness.teardown();
  });

  /** The access-token lifetime a revocation record has to outlive. */
const ACCESS_TTL = 900;

describe('accounts', () => {
    it('round-trips an account', async () => {
      const account = anAccount();
      await harness.accounts.save(account);

      const found = await harness.accounts.findById(account.id);

      expect(found).not.toBeNull();
      expect(found?.email).toBe(account.email);
      expect(found?.kind).toBe('applicant');
      expect(found?.passwordHash).toBe(account.passwordHash);
    });

    /**
     * The defect this pins: registration validated a first name, a last name
     * and a mobile number, then discarded all three. The account it created
     * could never file — every applicant write path refused it with "This
     * account has no applicant profile" — and no route existed to add one.
     *
     * In the contract suite rather than beside one implementation, because the
     * in-memory repository would have kept passing while PostgreSQL stayed
     * broken. That asymmetry is exactly what this suite exists to catch.
     */
    it('saves an applicant profile alongside the account', async () => {
      const account = anAccount({ kind: 'applicant' });

      await harness.accounts.save(account, {
        firstName: 'Maria', lastName: 'Santos', mobileNumber: '09171234567',
        middleName: null, street: null, barangay: null, city: null,
        province: null, postalCode: null,
      });

      const profile = await harness.accounts.profileOf(account.id);
      // The WHOLE profile, both repositories alike. The address parts read back
      // null because registration does not collect them (migration 036) --
      // null meaning NOT RECORDED, which a client must not render as a blank
      // the citizen chose to leave empty.
      expect(profile).toEqual({
        firstName: 'Maria', middleName: null, lastName: 'Santos',
        mobileNumber: '09171234567',
        street: null, barangay: null, city: null, province: null, postalCode: null,
      });
    });

    it('leaves a staff account without a profile', async () => {
      // The other half. `profileOf` returning null for an officer is the
      // designed answer, not an omission, and a save that invented a profile
      // for every account would make the null impossible to reach.
      const account = anAccount({ kind: 'staff' });

      await harness.accounts.save(account);

      expect(await harness.accounts.profileOf(account.id)).toBeNull();
    });

    it('returns null for an id that does not exist', async () => {
      expect(await harness.accounts.findById(randomUUID())).toBeNull();
    });

    it('finds by email regardless of case or surrounding space', async () => {
      const account = anAccount({ email: 'Maria.Santos@Example.PH' });
      await harness.accounts.save(account);

      expect(await harness.accounts.findByEmail('maria.santos@example.ph')).not.toBeNull();
      expect(await harness.accounts.findByEmail('  MARIA.SANTOS@EXAMPLE.PH ')).not.toBeNull();
    });

    it('returns null for an email that does not exist', async () => {
      expect(await harness.accounts.findByEmail('nobody@example.ph')).toBeNull();
    });

    it('updates a password hash without touching anything else', async () => {
      const account = anAccount();
      await harness.accounts.save(account);

      await harness.accounts.updatePasswordHash(account.id, 'scrypt$65536$8$2$bmV3$bmV3aGFzaA');
      const found = await harness.accounts.findById(account.id);

      expect(found?.passwordHash).toBe('scrypt$65536$8$2$bmV3$bmV3aGFzaA');
      expect(found?.email).toBe(account.email);
    });

    it('stores and returns staff roles', async () => {
      const officer = anAccount({ kind: 'staff', roles: ['evaluator', 'records-officer'] });
      await harness.accounts.save(officer);

      const found = await harness.accounts.findById(officer.id);

      expect(found?.roles.slice().sort()).toEqual(['evaluator', 'records-officer']);
    });

    it('replaces roles wholesale rather than merging them', async () => {
      // A diff would silently keep a role the caller dropped -- which is a
      // privilege that outlives the decision to remove it.
      const officer = anAccount({ kind: 'staff', roles: ['evaluator', 'assessor'] });
      await harness.accounts.save(officer);

      await harness.accounts.save({ ...officer, roles: ['evaluator'] });

      expect((await harness.accounts.findById(officer.id))?.roles).toEqual(['evaluator']);
    });

    it('records a disabled account as disabled', async () => {
      const account = anAccount({ disabledAt: new Date('2026-08-01T00:00:00Z') });
      await harness.accounts.save(account);

      expect((await harness.accounts.findById(account.id))?.disabledAt).not.toBeNull();
    });
  });

  describe('refresh tokens', () => {
    it('round-trips a token', async () => {
      const account = anAccount();
      await harness.accounts.save(account);
      const token = aToken(account.id);
      await harness.sessions.save(token);

      const found = await harness.sessions.findById(token.id);

      expect(found?.familyId).toBe(token.familyId);
      expect(found?.accountId).toBe(account.id);
      expect(found?.secretDigest).toBe(token.secretDigest);
      expect(found?.consumedAt).toBeNull();
      expect(found?.revokedAt).toBeNull();
    });

    it('returns null for an unknown id', async () => {
      expect(await harness.sessions.findById(randomUUID())).toBeNull();
    });

    it('returns null for a malformed id rather than throwing', async () => {
      // The id comes from a caller. A bad token must be a 401, not a 500.
      expect(await harness.sessions.findById('not-a-uuid')).toBeNull();
    });

    it('marks a token consumed', async () => {
      const account = anAccount();
      await harness.accounts.save(account);
      const token = aToken(account.id);
      await harness.sessions.save(token);

      await harness.sessions.markConsumed(token.id, new Date('2026-08-19T13:00:00Z'));

      expect((await harness.sessions.findById(token.id))?.consumedAt).not.toBeNull();
    });

    it('revokes a family and reports how many it revoked', async () => {
      const account = anAccount();
      await harness.accounts.save(account);
      const family = randomUUID();
      await harness.sessions.save(aToken(account.id, { familyId: family }));
      await harness.sessions.save(aToken(account.id, { familyId: family }));
      const other = aToken(account.id);
      await harness.sessions.save(other);

      const revoked = await harness.sessions.revokeFamily(family, new Date(), ACCESS_TTL);

      expect(revoked).toBe(2);
      expect((await harness.sessions.findById(other.id))?.revokedAt).toBeNull();
    });

    it('does not re-revoke an already revoked family', async () => {
      const account = anAccount();
      await harness.accounts.save(account);
      const family = randomUUID();
      await harness.sessions.save(aToken(account.id, { familyId: family }));

      await harness.sessions.revokeFamily(family, new Date(), ACCESS_TTL);

      expect(await harness.sessions.revokeFamily(family, new Date(), ACCESS_TTL)).toBe(0);
    });

    it('revokes every family of one account and leaves others alone', async () => {
      const mine = anAccount();
      const theirs = anAccount();
      await harness.accounts.save(mine);
      await harness.accounts.save(theirs);
      await harness.sessions.save(aToken(mine.id));
      await harness.sessions.save(aToken(mine.id));
      const untouched = aToken(theirs.id);
      await harness.sessions.save(untouched);

      expect(await harness.sessions.revokeAllForAccount(mine.id, new Date(), ACCESS_TTL)).toBe(2);
      expect((await harness.sessions.findById(untouched.id))?.revokedAt).toBeNull();
    });

    it('counts only live families', async () => {
      const account = anAccount();
      await harness.accounts.save(account);
      const live = aToken(account.id);
      const consumed = aToken(account.id);
      await harness.sessions.save(live);
      await harness.sessions.save(consumed);
      await harness.sessions.markConsumed(consumed.id, new Date());

      expect(await harness.sessions.countActiveFamilies(account.id)).toBe(1);
    });
  });
});
