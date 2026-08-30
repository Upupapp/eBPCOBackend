import { STABLE_CURSOR, STABLE_INSTANT, STABLE_UUID, stabilise } from './stabilise';

/**
 * The one property that matters: stabilising must never turn a server bug into
 * a passing gate.
 */

describe('what is replaced', () => {
  it('replaces a valid uuid', () => {
    expect(stabilise({ id: '9e2efc0c-57f5-43cb-8cb5-5d8ba9f9abd2' }))
      .toEqual({ id: STABLE_UUID });
  });

  it('replaces a valid RFC 3339 instant', () => {
    expect(stabilise({ updatedAt: '2026-08-19T15:21:14.517Z' }))
      .toEqual({ updatedAt: STABLE_INSTANT });
  });

  it('replaces an id embedded in a path', () => {
    // The bug this had on the first attempt: the pattern carried its anchors,
    // so an inline id never matched and every request path kept churning.
    expect(stabilise({ path: '/staff/applications/9e2efc0c-57f5-43cb-8cb5-5d8ba9f9abd2/transitions' }))
      .toEqual({ path: `/staff/applications/${STABLE_UUID}/transitions` });
  });

  it('replaces a cursor, which encodes both and moves whenever either does', () => {
    expect(stabilise({ nextCursor: 'MjAyNi0wOC0xOVQxNjoyNzozMi4wMTNa' }))
      .toEqual({ nextCursor: STABLE_CURSOR });
  });

  it('leaves a null cursor alone, because absent and stabilised are different', () => {
    expect(stabilise({ nextCursor: null })).toEqual({ nextCursor: null });
  });

  it('reaches into arrays and nested objects', () => {
    expect(stabilise({ items: [{ id: '9e2efc0c-57f5-43cb-8cb5-5d8ba9f9abd2' }] }))
      .toEqual({ items: [{ id: STABLE_UUID }] });
  });
});

describe('what is NOT replaced — the whole point', () => {
  it('leaves a timestamp with no offset exactly as the server produced it', () => {
    // A timestamp without an offset is one two systems in different places
    // disagree about. If the server emits one it must reach the validator, and
    // normalising it here would report a passing gate for a check never made.
    const malformed = '2026-08-19 15:21:14';

    expect(stabilise({ updatedAt: malformed })).toEqual({ updatedAt: malformed });
  });

  it('leaves a truncated timestamp alone', () => {
    expect(stabilise({ dueDate: '2026-08-19T15:21' })).toEqual({ dueDate: '2026-08-19T15:21' });
  });

  it('leaves a malformed uuid alone', () => {
    const malformed = '9e2efc0c-57f5-43cb-8cb5';

    expect(stabilise({ id: malformed })).toEqual({ id: malformed });
  });

  it('leaves a uuid with the wrong version alone', () => {
    // Version 0 is not a UUID anything here should be producing.
    const wrong = '9e2efc0c-57f5-03cb-8cb5-5d8ba9f9abd2';

    expect(stabilise({ id: wrong })).toEqual({ id: wrong });
  });

  it('leaves ordinary values untouched', () => {
    expect(stabilise({
      referenceNumber: 'E-BPCO-2026-000041',
      totalCentavos: 682_000,
      paymentVerified: false,
      classification: null,
      dueDate: '2026-07-23',
    })).toEqual({
      referenceNumber: 'E-BPCO-2026-000041',
      totalCentavos: 682_000,
      paymentVerified: false,
      classification: null,
      dueDate: '2026-07-23',
    });
  });

  it('does not touch a number that happens to look like a date', () => {
    expect(stabilise({ year: 2026 })).toEqual({ year: 2026 });
  });
});

describe('stability', () => {
  it('is idempotent, so re-running the emitter changes nothing', () => {
    const once = stabilise({ id: '9e2efc0c-57f5-43cb-8cb5-5d8ba9f9abd2', at: '2026-08-19T15:21:14.517Z' });

    expect(stabilise(once)).toEqual(once);
  });
});
