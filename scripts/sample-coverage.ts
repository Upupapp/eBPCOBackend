/**
 * How much of the route table has a RECORDED RESPONSE behind it.
 *
 * A recorded sample is real bytes from the real controller, validated against
 * the contract on every run. A route with none is a route whose response shape
 * is described only by the code that produces it — which is exactly the
 * situation the recorded-response approach exists to end, and it is invisible
 * without counting.
 *
 * ── Why a floor rather than a target ────────────────────────────────────
 *
 * The number is not going to reach 82 soon and pretending otherwise would make
 * this gate a nag. Most of the gap is write endpoints, and a sample for a write
 * needs state built in a particular order — a response produced from a
 * half-built fixture documents something the system never really sends, which
 * is worse than no sample at all.
 *
 * So the gate holds a FLOOR. Coverage may rise freely; it may not fall. Adding
 * a route without a sample is allowed and honest, and dropping an existing
 * sample is not.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const say = (line = ''): void => void process.stdout.write(`${line}\n`);
const warn = (line: string): void => void process.stderr.write(`${line}\n`);

/** Raised deliberately, never lowered to make a run pass. */
const FLOOR = 35;

interface Sample {
  request?: { method?: string; path?: string };
}

function main(): void {
  const root = resolve(__dirname, '..');
  const routes = (JSON.parse(
    readFileSync(resolve(root, 'contract/route-table.json'), 'utf8'),
  ) as { routes: string[] }).routes;
  const samples = (JSON.parse(
    readFileSync(resolve(root, 'contract/response-samples.json'), 'utf8'),
  ) as { samples: Record<string, Sample> }).samples;

  // A recorded path carries real ids; the route table carries `:params`. Both
  // are reduced to the same shape rather than compared as written.
  const recorded = new Set<string>();
  for (const sample of Object.values(samples)) {
    const method = sample.request?.method;
    const path = sample.request?.path;
    if (method === undefined || path === undefined) continue;
    recorded.add(`${method} ${path.replace(/\/[0-9a-fA-F-]{36}/g, '/:id')}`);
  }

  const missing = routes.filter(
    (route) => !recorded.has(route.replace(/:\w+/g, ':id')),
  );
  const covered = routes.length - missing.length;

  say(`RECORDED RESPONSES — ${covered} of ${routes.length} routes, floor ${FLOOR}`);
  if (missing.length > 0) {
    say(`  ${missing.length} route(s) have no recorded response:`);
    for (const route of missing) say(`    ${route}`);
  }

  if (covered < FLOOR) {
    warn(`\n  FAIL  coverage fell to ${covered}, below the floor of ${FLOOR}. `
      + 'A sample was removed or a recording stopped working.');
    process.exit(1);
  }
  if (covered > FLOOR) {
    warn(`\n  FAIL  coverage is ${covered}, above the floor of ${FLOOR}. `
      + `Raise FLOOR in scripts/sample-coverage.ts to ${covered} so it cannot fall back.`);
    process.exit(1);
  }
  say('  ok   every route that had a recorded response still has one');
}

main();
