import { FORM_LIMITS, FORM_SCHEMAS, schemaFor, validateStructure } from './application-form';

/**
 * Two kinds of validation, and only one of them is possible today.
 *
 * Structural — how big, how deep, how many fields — does not depend on knowing
 * what a Fencing Permit asks for. Semantic does, and the forms have not been
 * supplied (M-10).
 */

const ok = (form: unknown): boolean => validateStructure(form).length === 0;

describe('what an ordinary form does', () => {
  it('passes', () => {
    expect(ok({
      lotArea: 240,
      storeys: 2,
      engineer: 'Ana Dela Cruz, PRC 0012345',
      scope: { fencing: { linearMetres: 42, material: 'hollow block' } },
      attachments: ['lot-plan', 'tax-declaration'],
    })).toBe(true);
  });

  it('passes when empty', () => {
    // There is no such thing as an application with no answers — only one with
    // none yet.
    expect(ok({})).toBe(true);
  });
});

describe('bounds that do not need the LGU’s forms', () => {
  it('refuses something that is not an object', () => {
    expect(ok('a string')).toBe(false);
    expect(ok([1, 2, 3])).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it('refuses a form larger than the limit', () => {
    // An endpoint that accepts arbitrary JSON with no bounds accepts a
    // ten-megabyte nested object, and a client that can send one can exhaust a
    // server that has to parse it.
    const huge = { notes: 'x'.repeat(FORM_LIMITS.maxSerialisedBytes + 1) };

    const violations = validateStructure(huge);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/KB/);
  });

  it('stops walking a form that is already too large', () => {
    // Walking a structure that has already been refused is work done on behalf
    // of a caller who has already been told no.
    const huge = { a: 'x'.repeat(FORM_LIMITS.maxSerialisedBytes), b: 'y'.repeat(20_000) };

    expect(validateStructure(huge)).toHaveLength(1);
  });

  it('refuses a form nested deeper than the limit', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let level = 0; level <= FORM_LIMITS.maxDepth + 1; level += 1) deep = { nested: deep };

    expect(ok(deep)).toBe(false);
  });

  it('refuses a single value longer than the limit', () => {
    expect(ok({ remarks: 'x'.repeat(FORM_LIMITS.maxStringLength + 1) })).toBe(false);
  });

  it('refuses an array longer than the limit', () => {
    expect(ok({ owners: Array.from({ length: FORM_LIMITS.maxArrayLength + 1 }, () => 'a') })).toBe(false);
  });

  it('refuses a form with more fields than the limit', () => {
    const wide = Object.fromEntries(
      Array.from({ length: FORM_LIMITS.maxFields + 1 }, (_, i) => [`field${i}`, i]),
    );

    expect(ok(wide)).toBe(false);
  });
});

describe('what the applicant is told', () => {
  it('points at the field, not at the form', () => {
    // "Some answers are not valid" sends someone back through fifteen screens.
    const violations = validateStructure({
      scope: { fencing: { material: 'x'.repeat(FORM_LIMITS.maxStringLength + 1) } },
    });

    expect(violations[0]!.pointer).toBe('/form/scope/fencing/material');
  });

  it('escapes a field name containing a slash, so the pointer is unambiguous', () => {
    // RFC 6901. Without this a field literally named "a/b" reads as two levels.
    const violations = validateStructure({ 'a/b': 'x'.repeat(FORM_LIMITS.maxStringLength + 1) });

    expect(violations[0]!.pointer).toBe('/form/a~1b');
  });

  it('points into an array by index', () => {
    const violations = validateStructure({
      owners: ['fine', 'x'.repeat(FORM_LIMITS.maxStringLength + 1)],
    });

    expect(violations[0]!.pointer).toBe('/form/owners/1');
  });

  it('stops after enough violations to act on', () => {
    // A wall of errors is not more useful than twenty.
    const bad = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`f${i}`, 'x'.repeat(FORM_LIMITS.maxStringLength + 1)]),
    );

    expect(validateStructure(bad).length).toBeLessThanOrEqual(20);
  });
});

describe('semantic schemas', () => {
  it('has none, and that is the honest state', () => {
    // Every entry has to come from the LGU's published form (M-10). The
    // registry existing while empty is what makes the absence visible and typed
    // rather than an omission somebody has to notice.
    expect(Object.keys(FORM_SCHEMAS)).toEqual([]);
    expect(schemaFor('Fencing Permit')).toBeUndefined();
  });
});
