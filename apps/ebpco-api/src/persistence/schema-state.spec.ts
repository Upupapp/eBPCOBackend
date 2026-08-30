import { AppliedMigration, Migration, checksum } from './migrator';
import { compareSchema, describe as describeVerdict, servesTraffic } from './schema-state';

/**
 * The check that decides whether a process may serve at all.
 *
 * The one this replaces compared counts. Every case below is one it could not
 * see, and each produces a process serving requests against a schema it does
 * not understand.
 */

const migration = (version: number, name: string, sql: string): Migration => ({ version, name, sql });

const appliedFrom = (m: Migration, at = new Date('2026-08-20T00:00:00Z')): AppliedMigration => ({
  version: m.version,
  name: m.name,
  checksum: checksum(m.sql),
  appliedAt: at,
});

const one = migration(1, 'identity', 'create table accounts (id uuid primary key);');
const two = migration(2, 'reference', 'create table permit_types (permit_type text primary key);');
const three = migration(3, 'applications', 'create table applications (id uuid primary key);');

describe('when the ledger and the build agree', () => {
  it('is current, and serves', () => {
    const verdict = compareSchema([one, two], [appliedFrom(one), appliedFrom(two)]);

    expect(verdict.state).toBe('current');
    expect(servesTraffic(verdict)).toBe(true);
  });

  it('is current with nothing on either side', () => {
    expect(compareSchema([], []).state).toBe('current');
  });
});

describe('when the database is behind', () => {
  it('names the migrations rather than counting them', () => {
    // "1 migration(s) not applied" sends an operator looking. Naming it tells
    // them what to run.
    const verdict = compareSchema([one, two, three], [appliedFrom(one), appliedFrom(two)]);

    expect(verdict.state).toBe('behind');
    expect(servesTraffic(verdict)).toBe(false);
    expect(describeVerdict(verdict)).toContain('3 applications');
  });

  it('refuses to serve, because the code expects tables that are not there', () => {
    // Better to fail the health gate and never enter rotation than to serve
    // errors that look like application bugs.
    const verdict = compareSchema([one, two], [appliedFrom(one)]);

    expect(servesTraffic(verdict)).toBe(false);
  });
});

describe('when a migration was edited after it was applied', () => {
  it('is divergent, which counting could never see', () => {
    // The most common way this goes wrong in practice: editing a migration
    // "just to fix the comment" after it has run somewhere. The count matches;
    // the database is not what the code was tested against.
    const edited = migration(2, 'reference', `${two.sql}\n-- clarified\n`);

    const verdict = compareSchema([one, edited], [appliedFrom(one), appliedFrom(two)]);

    expect(verdict.state).toBe('divergent');
    expect(servesTraffic(verdict)).toBe(false);
  });

  it('says running them again will not fix it', () => {
    // The instinct on seeing a schema complaint is to run the migrations. Here
    // that changes nothing, and the message has to say so or an operator loses
    // an hour to it.
    const renamed = migration(2, 'reference', 'create table permit_types (permit_type text);');
    const verdict = compareSchema([one, renamed], [appliedFrom(one), appliedFrom(two)]);

    expect(describeVerdict(verdict)).toContain('will not fix it');
  });

  it('reports divergence ahead of anything else', () => {
    // A checksum mismatch alongside a missing migration is still divergence:
    // reporting "behind" would send an operator to run a migration that will
    // not address the real problem.
    const edited = migration(1, 'identity', `${one.sql}\n-- edited\n`);

    const verdict = compareSchema([edited, two, three], [appliedFrom(one)]);

    expect(verdict.state).toBe('divergent');
  });
});

describe('when the database is ahead of the build', () => {
  it('is detected at all, which subtraction could not do', () => {
    // expected.length - applied.length was NEGATIVE here, which is not greater
    // than zero, which reported healthy. It is the exact state a rollback
    // creates.
    const verdict = compareSchema([one, two], [appliedFrom(one), appliedFrom(two), appliedFrom(three)]);

    expect(verdict.state).toBe('ahead');
  });

  it('SERVES anyway, and says so out loud', () => {
    // The decision worth arguing about. Refusing is tempting — the database has
    // changed in ways this build has not seen — but it is the normal state of
    // every rolling deploy that migrates before it rolls, and of every
    // rollback. A build that refuses whenever the schema is newer takes the
    // service down at exactly the moment someone is recovering it.
    const verdict = compareSchema([one], [appliedFrom(one), appliedFrom(two)]);

    expect(servesTraffic(verdict)).toBe(true);
    expect(describeVerdict(verdict)).toContain('Serving anyway');
    expect(describeVerdict(verdict)).toContain('2 reference');
  });
});

describe('out-of-order application', () => {
  it('treats a gap as behind, not as current', () => {
    // Two developers merging migrations 2 and 3 independently: 3 is applied,
    // 2 never is. The counts match and the schema is wrong.
    const verdict = compareSchema([one, two, three], [appliedFrom(one), appliedFrom(three)]);

    expect(verdict.state).toBe('behind');
    expect(servesTraffic(verdict)).toBe(false);
  });
});
