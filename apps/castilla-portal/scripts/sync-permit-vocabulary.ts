import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the permit vocabulary as the two other repositories currently hold it.
 *
 * Read-only against both: the admin portal and the public site are other
 * lanes, and this script exists to DETECT drift, never to correct it. If the
 * lists disagree, that disagreement is the finding and a person decides which
 * side is wrong — an automatic fix here would silently rename permits in a
 * live transaction system.
 */
const ADMIN_REPO = '/Users/user/ebpco-admin';
const ADMIN_FILE = 'src/app/core/domain/permit.model.ts';
const PORTAL_REPO = '/Users/user/eBPCO-Website';
const PORTAL_FILE = 'castilla-lgu-portal/src/app/core/data/permits.data.ts';

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The string literals of an array declaration, in source order. */
function namesIn(source: string, declaration: RegExp): string[] {
  const start = declaration.exec(source);
  if (start === null) throw new Error(`declaration not found: ${String(declaration)}`);
  const body = source.slice(start.index + start[0].length);
  const end = body.indexOf('];');
  if (end < 0) throw new Error('unterminated array declaration');
  return [...body.slice(0, end).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

function main(): number {
  for (const repo of [ADMIN_REPO, PORTAL_REPO]) {
    if (!existsSync(repo)) {
      console.error(`missing repository: ${repo}`);
      return 1;
    }
  }

  const adminCommit = git(ADMIN_REPO, ['rev-parse', 'HEAD']).trim();
  const portalCommit = git(PORTAL_REPO, ['rev-parse', 'HEAD']).trim();

  const admin = namesIn(
    git(ADMIN_REPO, ['show', `${adminCommit}:${ADMIN_FILE}`]),
    /export const ALL_PERMIT_TYPES: PermitType\[\] = \[/);
  // The portal writes `name: '...'` on each catalogue entry.
  const portalSource = git(PORTAL_REPO, ['show', `${portalCommit}:${PORTAL_FILE}`]);
  const portal = [...portalSource.matchAll(/^ {4}name: '((?:[^'\\]|\\.)*)',$/gm)].map((m) => m[1]!);

  const document = {
    _comment:
      'Pinned by scripts/sync-permit-vocabulary.ts. Do not hand-edit. If the two lists disagree '
      + 'with each other or with src/permits/vocabulary.ts, that disagreement is the finding.',
    admin: { repo: 'ebpco-admin', file: ADMIN_FILE, commit: adminCommit, names: admin },
    portal: { repo: 'Upupapp/eBPCO-Website', file: PORTAL_FILE, commit: portalCommit, names: portal },
  };

  const path = join(__dirname, '../contract/permit-vocabulary.json');
  const rendered = `${JSON.stringify(document, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const existing = readFileSync(path, 'utf8');
    if (existing === rendered) {
      console.log(`ok   permit vocabulary matches admin ${adminCommit.slice(0, 7)} `
        + `and portal ${portalCommit.slice(0, 7)}`);
      return 0;
    }
    // A moved commit with identical names is not drift. Only the NAMES gate.
    const pinned = JSON.parse(existing) as typeof document;
    const same = JSON.stringify(pinned.admin.names) === JSON.stringify(admin)
      && JSON.stringify(pinned.portal.names) === JSON.stringify(portal);
    if (same) {
      console.log('ok   permit vocabulary unchanged; the pinned commits have moved. '
        + 'Run `npm run vocabulary:sync` to re-pin.');
      return 0;
    }
    console.error('DRIFT: the permit vocabulary no longer matches the pinned lists.');
    return 1;
  }

  writeFileSync(path, rendered);
  console.log(`wrote ${path}: admin ${admin.length} names, portal ${portal.length} names`);
  return 0;
}

process.exit(main());
