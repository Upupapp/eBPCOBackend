import fc from 'fast-check';

import { MAX_CENTAVOS, MoneyError, centavos, formatPeso, parseCentavos, subtract, sum } from './money';

describe('constructing an amount', () => {
  it('accepts a whole, non-negative number of centavos', () => {
    expect(centavos(0)).toBe(0);
    expect(centavos(1_260_250)).toBe(1_260_250);
  });

  it.each([
    ['a fraction of a centavo', 50_000.75],
    ['a tiny fraction', 0.1],
    ['a negative amount', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', (_label, value) => {
    expect(() => centavos(value)).toThrow(MoneyError);
  });

  it('explains that a fraction is the problem, not that "it is invalid"', () => {
    // PHP 500.0075 is not PHP 500.01, and rounding it would put a figure on an
    // Order of Payment that nobody decided.
    expect(() => centavos(50_000.75)).toThrow(/whole number of centavos/);
  });
});

describe('no arithmetic path can produce a bad amount', () => {
  // Acceptance criterion, stated as a property rather than as examples: the
  // examples anyone thinks to write are the ones the code already handles.

  it('sums any list of valid amounts to a valid amount', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { maxLength: 50 }), (values) => {
        const total = sum(values.map((v) => centavos(v)));

        expect(Number.isInteger(total)).toBe(true);
        expect(total).toBeGreaterThanOrEqual(0);
        expect(total).toBe(values.reduce((a, b) => a + b, 0));
      }),
      { numRuns: 500 },
    );
  });

  it('never produces a total smaller than its largest part', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 20 }), (values) => {
        expect(sum(values.map((v) => centavos(v)))).toBeGreaterThanOrEqual(Math.max(...values));
      }),
      { numRuns: 500 },
    );
  });

  it('is associative, so the order fee lines are added in cannot change the total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (a, b, c) => {
          const forwards = sum([centavos(a), centavos(b), centavos(c)]);
          const backwards = sum([centavos(c), centavos(b), centavos(a)]);
          expect(forwards).toBe(backwards);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses to subtract into a negative balance', () => {
    // An overpayment is a different fact needing a different answer.
    // Representing it as a negative balance is how a refund becomes a credit
    // nobody notices.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (a, b) => {
          const from = centavos(Math.min(a, b));
          const amount = centavos(Math.max(a, b));
          if (amount > from) {
            expect(() => subtract(from, amount)).toThrow(MoneyError);
          } else {
            expect(subtract(from, amount)).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a sum that would leave the exactly-representable range', () => {
    const huge = centavos(MAX_CENTAVOS);
    expect(() => sum([huge, huge, huge])).toThrow(MoneyError);
  });

  it('round-trips through the parser for every valid amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_CENTAVOS }), (value) => {
        expect(parseCentavos(value)).toBe(value);
        expect(parseCentavos(String(value))).toBe(value);
      }),
      { numRuns: 500 },
    );
  });
});

describe('reading an amount from outside', () => {
  it('accepts a whole-number string, as PostgreSQL returns', () => {
    expect(parseCentavos('1260250')).toBe(1_260_250);
  });

  it.each([
    ['a peso string', '1,234.50'],
    ['a decimal string', '1234.50'],
    ['a float', 1234.5],
    ['null', null],
    ['an object', {}],
  ])('refuses %s', (_label, value) => {
    // Converting pesos to centavos in one place is fine; doing it implicitly
    // wherever a value is read is how a fee ends up multiplied by a hundred.
    expect(() => parseCentavos(value)).toThrow(MoneyError);
  });
});

describe('display', () => {
  it('formats centavos as pesos without ever being used to compute', () => {
    expect(formatPeso(centavos(1_260_250))).toBe('PHP 12,602.50');
    expect(formatPeso(centavos(5))).toBe('PHP 0.05');
    expect(formatPeso(centavos(0))).toBe('PHP 0.00');
  });

  it('never loses a centavo in formatting', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (value) => {
        const formatted = formatPeso(centavos(value));
        const digits = formatted.replace(/[^0-9]/g, '');
        expect(Number(digits)).toBe(value);
      }),
      { numRuns: 300 },
    );
  });
});
