import { readProvenance } from './provenance';

/**
 * The reader's contract, tested directly.
 *
 * A break-check that should have failed did not: making the method default to
 * 'direct-read' when a comment says nothing about how a fact was obtained
 * passed every seeding test. Not because the guard is weak, but because every
 * dated comment in today's portal data happens to match a method phrase -- so
 * the fallback never fires and no seeded assertion can see it.
 *
 * A guard nothing exercises is a guard nobody will notice losing. These are
 * unit tests of the function, not of this week's data.
 */

describe('a comment becomes provenance only when it says enough', () => {
  it('reads a date and a method the comment states', () => {
    const reading = readProvenance(
      'Sourced 2026-08-23 from the LGU Citizen\'s Charter.',
    );

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.provenance.sourcedOn).toBe('2026-08-23');
    expect(reading.provenance.method).toBe('official-document');
  });

  it('REFUSES a dated comment that never says how the fact was obtained', () => {
    // The case the seeded tests cannot reach. Guessing here would put an
    // unchecked claim in an audit trail whose entire purpose is being checkable.
    const reading = readProvenance('Sourced 2026-08-23. He is the incumbent.');

    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.reason).toMatch(/how the fact was obtained/);
  });

  it('refuses a comment with no date, however well it describes the source', () => {
    // Several comments in the source explain why a fact is ABSENT. Those are
    // notes, not provenance, and they correctly have no sourcing date.
    const reading = readProvenance(
      'Direct phone and email not found — the Mayor\'s Office line should not be '
      + "presented as the Administrator's direct contact.",
    );

    expect(reading.ok).toBe(false);
  });

  it('refuses no comment at all', () => {
    expect(readProvenance(null).ok).toBe(false);
    expect(readProvenance('   ').ok).toBe(false);
  });

  it('prefers the weaker claim when a comment states two methods', () => {
    // "read the official page via search-result extraction" is a search
    // extraction. That is the claim a reader needs, because the stronger one is
    // not what happened.
    const reading = readProvenance(
      'Sourced 2026-08-23 from the official LGU vision page, via search-result '
      + 'extraction since the page blocks automated fetching.',
    );

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.provenance.method).toBe('search-extraction');
  });

  it('keeps the comment whole as the description', () => {
    // Summarising would be this seeder deciding which half of someone's careful
    // sourcing note matters. The audit trail is the words they wrote.
    const comment = 'Sourced 2026-08-23: LGU Citizen\'s Charter, corroborated by a PSA '
      + 'Sorsogon publication (2024 CBMS presentation, August 2025).';
    const reading = readProvenance(comment);

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.provenance.sourceDescription).toBe(comment);
  });
});
