import { CATALOG, deepLinkFor, entryFor, isInCatalog } from './catalog';

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
