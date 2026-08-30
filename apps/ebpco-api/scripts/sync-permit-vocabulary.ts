/**
 * Extracts the published permit vocabulary from its two holders.
 *
 * The 19 canonical permit names live in the admin portal's `ALL_PERMIT_TYPES`
 * and in the public portal's catalogue. They match verbatim and in order today
 * and NOTHING CHECKS IT -- the portal's own test named "groups all 19 permit
 * types" asserts only that its data file equals itself.
 *
 * Extracted rather than hand-transcribed, and the source commit is stamped on
 * the result. A hand-copied list is right on the day it is written and silently
 * wrong afterwards; this one carries the evidence of where it came from, so a
 * reviewer can check it without trusting the person who ran the script.
 *
 * Both sources are in OTHER repositories, which is why this is a script and a
 * committed fixture rather than an import. The fixture is what the spec reads,
 * so the gate runs anywhere; running this script is what makes drift visible.
 *
 *   npm run sync:permits
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_REPO = process.env['EBPCO_ADMIN_REPO'] ?? '/Users/user/ebpco-admin';
const PORTAL_REPO = process.env['EBPCO_WEBSITE_REPO'] ?? '/Users/user/eBPCO-Website';

const ADMIN_FILE = 'src/app/core/domain/permit.model.ts';
const PORTAL_FILE = 'castilla-lgu-portal/src/app/core/data/permits.data.ts';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** `ALL_PERMIT_TYPES: PermitType[] = [ '…', '…' ];` */
function adminNames(source: string): string[] {
  const block = /ALL_PERMIT_TYPES[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  if (block === null) throw new Error('ALL_PERMIT_TYPES not found in the admin portal');
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Each catalogue entry carries `name: '…'` at a fixed indent. */
function portalNames(source: string): string[] {
  return [...source.matchAll(/^ {4}name: '([^']+)',$/gm)].map((m) => m[1]!);
}

function main(): number {
  const adminCommit = git(ADMIN_REPO, ['rev-parse', 'HEAD']);
  const portalCommit = git(PORTAL_REPO, ['rev-parse', 'HEAD']);

  // Read from the COMMIT, not the working tree. A dirty tree is somebody
  // else's work in progress, and pinning against it records a vocabulary that
  // was never published -- which is how this repository nearly gated the
  // Castilla portal against a superseded commit.
  const admin = adminNames(git(ADMIN_REPO, ['show', `${adminCommit}:${ADMIN_FILE}`]));
  const portal = portalNames(git(PORTAL_REPO, ['show', `${portalCommit}:${PORTAL_FILE}`]));

  if (admin.length === 0 || portal.length === 0) {
    process.stderr.write('extraction produced an empty list; the source shape has changed\n');
    return 1;
  }

  const output = join(__dirname, '../contract/permit-vocabulary.json');
  writeFileSync(output, `${JSON.stringify({
    _comment: 'Extracted by scripts/sync-permit-vocabulary.ts. Do not hand-edit: '
      + 're-run the script, and if the two lists disagree that is the finding.',
    admin: { repo: 'ebpco-admin', file: ADMIN_FILE, commit: adminCommit, names: admin },
    portal: {
      repo: 'Upupapp/eBPCO-Website', file: PORTAL_FILE, commit: portalCommit, names: portal,
    },
  }, null, 2)}\n`);

  process.stdout.write(
    `admin ${admin.length} names at ${adminCommit.slice(0, 7)}; `
    + `portal ${portal.length} at ${portalCommit.slice(0, 7)}\n`,
  );
  return 0;
}

process.exitCode = main();
