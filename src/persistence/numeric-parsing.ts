/**
 * How exact numeric types come back from PostgreSQL, for every adapter.
 *
 * Both `pg` and PGlite return BIGINT and NUMERIC as strings, because both can
 * exceed JavaScript's safe integer range. Left as strings they are a live bug:
 * `a + b` on two fee strings concatenates instead of adding and produces a
 * plausible number rather than an error.
 *
 * This lives in its own module so the production adapter and the test adapter
 * are given the same parsers by construction. They previously were not, and a
 * test asserting a zero fee line found it — the production client returned
 * `0` and the test client returned `"0"`, which means every test that read a
 * monetary value was reading a different type than production would.
 */

export const BIGINT_OID = 20;
export const NUMERIC_OID = 1700;

export function exactInteger(label: string) {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(
        `${label} ${value} is not a whole number. Every ${label} column in this schema is centavos ` +
          'and is constrained to scale 0, so this row was written by something that bypassed the constraint.',
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${label} ${value} exceeds the safe integer range; it cannot be a centavo amount`);
    }
    return parsed;
  };
}
