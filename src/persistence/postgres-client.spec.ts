import { types } from 'pg';

// Importing the module registers the parsers as a side effect, which is the
// point: they must be in force before any query runs, not opted into per call.
import './postgres-client';

const BIGINT_OID = 20;
const NUMERIC_OID = 1700;

describe('numeric parsing at the driver boundary', () => {
  const parseBigint = types.getTypeParser(BIGINT_OID) as (v: string) => number;
  const parseNumeric = types.getTypeParser(NUMERIC_OID) as (v: string) => number;

  it('returns a number, not a string', () => {
    // Left as a string, `a + b` on two fees concatenates instead of adding and
    // produces a plausible number rather than an error.
    expect(parseNumeric('1260250')).toBe(1_260_250);
    expect(parseBigint('42')).toBe(42);
    expect(typeof parseNumeric('0')).toBe('number');
  });

  it('handles a negative value, so a diagnostic query does not throw', () => {
    expect(parseNumeric('-5')).toBe(-5);
  });

  it('throws on a fractional value rather than rounding it', () => {
    // Reaching here means something wrote past the scale(v) = 0 constraint.
    // Silently rounding would hide that.
    expect(() => parseNumeric('50000.75')).toThrow(/not a whole number/);
  });

  it('throws beyond the safe integer range rather than losing precision', () => {
    expect(() => parseBigint('9007199254740993')).toThrow(/safe integer range/);
  });
});
