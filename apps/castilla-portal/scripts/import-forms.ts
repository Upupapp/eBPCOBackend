import { execFileSync } from 'node:child_process';

import { Pool } from 'pg';

import { BundledFile, FormImporter } from '../src/forms/form-importer';

/**
 * Imports the portal's bundled application forms and reconciles them against
 * the permits that cite them.
 *
 * Reads the files out of GIT at an explicit commit rather than off the working
 * tree, so what was imported is a thing you can name afterwards. Reports what
 * did not match instead of resolving it: an orphan is either a missing permit
 * link or a file that should not ship, and only a person can say which.
 */
const PORTAL_REPO = '/Users/user/eBPCO-Website';
const ASSET_DIR = 'castilla-lgu-portal/public/assets/permits';

const git = (args: string[]): Buffer =>
  execFileSync('git', ['-C', PORTAL_REPO, ...args], { maxBuffer: 256 * 1024 * 1024 });

function bundledAt(commit: string): BundledFile[] {
  const listing = git(['ls-tree', '--name-only', `${commit}:${ASSET_DIR}`])
    .toString('utf8').trim().split('\n')
    .filter((name) => name.toLowerCase().endsWith('.pdf'));

  return listing.map((filename) => ({
    filename,
    // Bytes exactly as committed. These are the LGU's and the BFP's own
    // documents and nothing here re-encodes them.
    bytes: git(['show', `${commit}:${ASSET_DIR}/${filename}`]),
  }));
}

async function main(): Promise<number> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    console.error('DATABASE_URL is not set');
    return 1;
  }

  const commit = git(['rev-parse', 'HEAD']).toString('utf8').trim();
  const files = bundledAt(commit);
  const pool = new Pool({ connectionString });

  try {
    const report = await new FormImporter(pool).run(files);

    console.log(`portal commit ${commit.slice(0, 7)}: ${files.length} bundled files`);
    console.log(`  imported ${report.imported}, unchanged ${report.unchanged}, `
      + `superseded ${report.superseded}, links ${report.linked}`);

    for (const rejected of report.rejected) {
      console.error(`  REJECTED ${rejected.file}: ${rejected.reason}`);
    }
    for (const orphan of report.orphans) {
      console.error(`  ORPHAN   ${orphan}: bundled but referenced by no permit. `
        + 'Either a permit is missing its link, or this file should not ship.');
    }
    for (const missing of report.dangling) {
      console.error(`  DANGLING ${missing}: a permit links to it and it is not bundled. `
        + 'That download is already dead on the live site.');
    }

    // Orphans and dangling references are findings, not crashes: the import
    // itself succeeded and the operator needs the whole list, not the first one.
    const findings = report.orphans.length + report.dangling.length + report.rejected.length;
    if (findings > 0) console.error(`\n${findings} finding(s) above need a person.`);
    return findings > 0 ? 2 : 0;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
