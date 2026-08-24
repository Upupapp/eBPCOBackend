import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOG, SERVER_CATALOG, deepLinkFor, entryFor, isInCatalog } from './catalog';

describe('the catalog is closed', () => {
  it('has exactly the twenty-five types the client declares', () => {
    // The number is the client's, not a choice made here. Changing it is a
    // breaking contract change, deliberately.
    expect(CATALOG).toHaveLength(25);
  });

  it('has no duplicate types', () => {
    expect(new Set(CATALOG.map((entry) => entry.type)).size).toBe(25);
  });

  it('names the client enum constant each type maps to', () => {
    // The mapping is mechanical -- kebab-case of the constant -- so it can be
    // checked rather than trusted.
    for (const entry of CATALOG) {
      const derived = entry.dartName.replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase();
      expect(entry.type).toBe(derived);
    }
  });

  it('marks the two the server never sends', () => {
    const clientOnly = CATALOG.filter((entry) => !entry.serverGenerated).map((entry) => entry.type);
    expect(clientOnly.sort()).toEqual(['draft-idle', 'professional-credential-expiring']);
  });

  it('rejects anything not in it', () => {
    expect(isInCatalog('order-of-payment-issued')).toBe(true);
    expect(isInCatalog('application.something-someone-invented')).toBe(false);
    expect(entryFor('nope')).toBeUndefined();
  });
});

describe('every entry can be acted on', () => {
  it('carries a deep link', () => {
    // A notification that cannot be acted on from itself will not be acted on.
    for (const entry of CATALOG) {
      expect(entry.deepLink.startsWith('/applications/')).toBe(true);
    }
  });

  it('substitutes the application id', () => {
    const entry = entryFor('order-of-payment-issued')!;
    expect(deepLinkFor(entry, 'abc-123')).toBe('/applications/abc-123/pay');
  });

  it('leaves no unsubstituted placeholder', () => {
    for (const entry of CATALOG) {
      expect(deepLinkFor(entry, 'abc-123')).not.toContain(':');
    }
  });

  it('points an action-required notice at the screen that RESOLVES it', () => {
    // Not merely at the application: at the thing the applicant has to do.
    expect(entryFor('revision-required')?.deepLink).toContain('/instructions');
    expect(entryFor('letter-of-instruction-issued')?.deepLink).toContain('/instructions');
    expect(entryFor('order-of-payment-issued')?.deepLink).toContain('/pay');
    expect(entryFor('ready-for-release')?.deepLink).toContain('/permit');
    expect(entryFor('rejected')?.deepLink).toContain('/outcome');
  });
});

describe('what each entry claims about itself', () => {
  it('marks as requiring action exactly what the badge should count', () => {
    const acting = CATALOG.filter((entry) => entry.requiresAction).map((entry) => entry.type);

    // Exactly the client's `action` priority, which had already decided this.
    expect(acting.sort()).toEqual([
      'inspection-scheduled', 'letter-of-instruction-issued', 'order-of-payment-issued',
      'payment-overdue', 'permit-commencement-warning', 'pledge-lapsed',
      'ready-for-release', 'rejected', 'revision-required',
    ]);
    expect(acting).not.toContain('received-by-obo');
    expect(acting).not.toContain('occupancy-now-possible');
  });

  it('marks as statutory every notice whose absence costs the applicant', () => {
    const statutory = CATALOG.filter((entry) => entry.statutory).map((entry) => entry.type);

    // statutory IS the client's action priority, not a second judgement.
    for (const entry of CATALOG) {
      expect(entry.statutory).toBe(entry.priority === 'action');
    }
    expect(statutory).toEqual(expect.arrayContaining(['rejected', 'pledge-lapsed']));
  });

  it('gives every entry copy an applicant can act on without opening the app', () => {
    for (const entry of CATALOG) {
      expect(entry.title.length).toBeGreaterThan(5);
      expect(entry.body.length).toBeGreaterThan(20);
      // No placeholder copy left in.
      expect(entry.body).not.toMatch(/^Your application has been updated/);
      expect(entry.dartName.length).toBeGreaterThan(3);
    }
  });
});

describe('every notice in the catalog has something that sends it', () => {
  // A catalog entry with no emitter is a notice the LGU believes it sends and
  // does not. That is not hypothetical here: `evaluation-stage-passed` had copy,
  // a category and a deep link, and nothing wrote it, so five evaluation stages
  // cleared in silence. It was found by counting, not by reading.
  //
  // So the count is a gate. The list below is the notices that genuinely have
  // no emitter yet, each with the reason, verified against the tree rather than
  // assumed. Adding an entry with no emitter fails this test; wiring one up
  // fails it too, until the line is removed. Neither direction is silent.
  //
  // WHAT THIS DOES NOT PROVE, stated because a gate trusted for more than it
  // checks is worse than no gate: it looks for the wire name as a literal in
  // the tree, so it catches a notice nothing MENTIONS. It does NOT catch one
  // that is mentioned inside a branch that never runs — disabling the emitter
  // in evaluation.service.ts leaves this passing, which was checked, not
  // assumed. Reachability is proved by the behavioural tests beside each
  // emitter; this gate exists to stop a type being added to the catalog and
  // forgotten, which is how the ten below accumulated.

  const NOT_YET_EMITTED: Readonly<Record<string, string>> = {
    'letter-of-instruction-issued':
      'nothing ISSUES a letter of instruction — the only path is respond(), and there is no create route',
    'fsec-cleared':
      'fire safety is recorded as an evaluation stage; there is no separate FSEC record or clearance route',
    'payment-overdue':
      'assessments carry a due_date, but no scheduled job compares it to the clock',
    'inspection-scheduled':
      'the inspections table exists (migration 005) and nothing inserts into it',
    'appointment-reminder':
      'there is no appointment feature — the word appears only as a mutable category',
    'pledge-approaching':
      'the pledge clock computes the date on read; no job watches it approach',
    'pledge-lapsed':
      'same — the lapse is computed when someone looks, and notices nobody',
    'permit-commencement-warning':
      'the PD 1096 commencement window is not tracked against a clock anywhere',
    'occupancy-now-possible':
      'no Certificate of Occupancy path distinct from the permit lifecycle, which already notifies on release',
    'account-update':
      'account changes write audit entries, not notices',
  };

  /** Every .ts under src that is not a test and not the catalog itself. */
  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sources(path, found);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.') && !path.endsWith(join('domain', 'catalog.ts'))) {
        found.push(path);
      }
    }
    return found;
  }

  const tree = sources(join(__dirname, '../../..'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  // SERVER_CATALOG, not a filter written again here. The catalog already names
  // "what the server may actually send"; computing it a second time is how two
  // definitions of one thing start disagreeing.
  const serverGenerated = SERVER_CATALOG;
  const unemitted = serverGenerated
    .filter((entry) => !tree.includes(`'${entry.type}'`))
    .map((entry) => entry.type);

  it('emits every server-generated notice except the ones listed, with reasons', () => {
    expect(unemitted.sort()).toEqual(Object.keys(NOT_YET_EMITTED).sort());
  });

  it('has a reason for each one, not a bare list', () => {
    for (const reason of Object.values(NOT_YET_EMITTED)) {
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it('reports how much of the catalog actually reaches an applicant', () => {
    // Recorded rather than asserted at a threshold: the number should move in
    // one direction, and a threshold would let it sit still.
    const emitted = serverGenerated.length - unemitted.length;
    expect(emitted).toBe(13);
    expect(serverGenerated).toHaveLength(23);
  });
});
