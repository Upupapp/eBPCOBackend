import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './app-config';

/**
 * What a deployment needs, checked against what the repository actually ships.
 *
 * These are not unit tests of `loadConfig`; they are the checks that would have
 * caught B-1's blockers. Each exists because the real one bit:
 *
 * `TOTP_ENCRYPTION_KEY` is mandatory outside development and was missing from
 * `.env.example`, so an operator following the template got a service that
 * started locally and refused to start in staging, naming a variable the
 * template had never mentioned. Ten more keys were undocumented alongside it.
 *
 * The migrations directory is read at RUNTIME by the readiness probe and was
 * not copied into the container image -- see the Dockerfile assertions below.
 */

const ROOT = join(__dirname, '../..');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/**
 * The template's own settings, as an environment.
 *
 * Deriving the environment FROM the template is what makes both directions
 * checkable with one parse. Feed it in, and every key the service reads comes
 * back -- from the input, or from its default. Every key zod strips is one the
 * template documents and nothing reads.
 *
 * Building the env from literals instead would silently answer a different
 * question: whether the keys I happened to think of are documented.
 */
const templateEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const match of envExample.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
    const [, key, value] = match;
    if (key !== undefined) env[key] = value ?? '';
  }
  return env;
};

/** Keys the template deliberately leaves unset, written as comments. */
const deliberatelyUnset = (): string[] =>
  [...envExample.matchAll(/^#\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);

const configuredKeys = (): string[] => Object.keys(loadConfig(templateEnv()));

describe('the environment template documents every variable the service reads', () => {
  it('names every key, required or optional', () => {
    const documented = new Set([
      ...Object.keys(templateEnv()),
      // A commented entry documents a variable whose absence is itself the
      // decision -- writing a value for DOCUMENT_RETENTION_DAYS would make a
      // retention choice on the LGU's behalf.
      ...deliberatelyUnset(),
    ]);

    expect(configuredKeys().filter((key) => !documented.has(key))).toEqual([]);
  });

  it('documents nothing the service does not read', () => {
    // The other direction. A variable in the template that nothing reads is an
    // operator setting something with no effect and believing otherwise.
    const configured = new Set(configuredKeys());

    // Only the keys the template actually SETS. A commented one is absent by
    // design and so cannot come back from a parse.
    expect(Object.keys(templateEnv()).filter((key) => !configured.has(key))).toEqual([]);
  });

  it('enumerates enough to mean something', () => {
    // Two empty lists compared to each other pass and prove nothing.
    expect(configuredKeys().length).toBeGreaterThan(15);
  });
});

describe('the container image carries what the service reads at runtime', () => {
  it('copies the migrations directory', () => {
    // `MIGRATIONS_DIR` resolves to `<app>/db/migrations` from `dist`, and the
    // readiness probe reads it on every check to compare the schema it expects
    // against the schema it found. Without the directory that check throws, is
    // caught, logs a warning and returns null -- and null is reported as UP.
    //
    // So the drift protection is silently inert in the only artefact anyone
    // would deploy, while passing in every test, where the directory exists.
    expect(dockerfile).toMatch(/COPY .*db\/migrations|COPY .*\bdb\b/);
  });

  it('does not exclude them from the build context', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    const excluded = dockerignore.split('\n').map((l) => l.trim());

    expect(excluded).not.toContain('db');
    expect(excluded).not.toContain('db/');
  });
});

describe('there is something to run migrations with', () => {
  it('exposes a migrate command', () => {
    // The service deliberately does NOT migrate on boot -- N replicas racing to
    // alter one schema, and a rollback that has to guess what was applied. The
    // design says migrations run in the deployment pipeline; until 2026-08-30
    // nothing existed for that pipeline to run.
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(Object.keys(scripts.scripts)).toContain('migrate');
  });
});

describe('migration numbering', () => {
  /**
   * Version numbers that no file uses, with the reason each is absent.
   *
   * A gap means a migration was renamed or removed, and the consequence only
   * appears at DEPLOY: `migrate` refuses a database holding a version this
   * build does not contain, because that means the code is older than the
   * schema. Nothing has been deployed yet, so today every gap is harmless --
   * which is exactly why it has to be written down now rather than discovered
   * by the first deployment.
   *
   * Renaming is not caught by the checksum rule either: moving
   * `026_x.sql` to `027_x.sql` changes the version and leaves the contents
   * identical, so the immutability check sees nothing.
   */
  const EXPLAINED_GAPS: Readonly<Record<number, string>> = {
    26: 'document_review was written by another lane as 026, swept into 9613f65 by a '
      + '`git add -A` that was not mine to make, then renamed to 027 by that lane in '
      + '8d83860 -- same file, byte for byte, same checksum. No database has ever '
      + 'applied version 26, so nothing can be holding it.',
  };

  it('has no unexplained gap in the sequence', () => {
    const versions = readdirSync(join(ROOT, 'db/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => Number(/^(\d+)/.exec(file)?.[1] ?? 0))
      .sort((a, b) => a - b);

    const highest = versions[versions.length - 1] ?? 0;
    const present = new Set(versions);
    const gaps: number[] = [];
    for (let version = 1; version <= highest; version += 1) {
      if (!present.has(version)) gaps.push(version);
    }

    // Checked both ways: a gap that closes has to be removed from the list, or
    // it becomes a note about something that used to be true.
    expect(gaps).toEqual(Object.keys(EXPLAINED_GAPS).map(Number));
  });

  it('numbers every migration uniquely, which is what makes a gap meaningful', () => {
    const versions = readdirSync(join(ROOT, 'db/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => Number(/^(\d+)/.exec(file)?.[1] ?? 0));

    expect(new Set(versions).size).toBe(versions.length);
  });
});
