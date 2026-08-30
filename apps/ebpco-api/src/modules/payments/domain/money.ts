/**
 * Money, as whole centavos, with arithmetic that cannot quietly go wrong.
 *
 * The contract's first non-negotiable is integer centavos end to end, and TAB
 * 04 found that a type alone does not enforce it — PostgreSQL rounds a
 * non-integer into a BIGINT rather than rejecting it. The same is true in
 * JavaScript, where `0.1 + 0.2` is not `0.3` and every fee is a `number`.
 *
 * So this is a nominal type over `number` with a constructor that refuses
 * anything that is not a safe, non-negative integer, and operations that refuse
 * to produce one. There is no way to obtain a `Centavos` except through
 * `centavos()`, which means there is no arithmetic path in the fee code that
 * can produce a value nobody checked.
 */

declare const brand: unique symbol;
export type Centavos = number & { readonly [brand]: 'Centavos' };

export class MoneyError extends Error {}

/** The largest amount this system will represent: PHP 90 trillion, in centavos. */
export const MAX_CENTAVOS = 9_000_000_000_000_000;

export function centavos(value: number): Centavos {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new MoneyError(`${String(value)} is not a number`);
  }
  if (!Number.isInteger(value)) {
    // The case the whole type exists for. PHP 500.0075 is not PHP 500.01, and
    // rounding it here would put a figure on an Order of Payment that nobody
    // decided.
    throw new MoneyError(`${value} is not a whole number of centavos`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${value} is beyond the range this system represents exactly`);
  }
  if (value < 0) {
    throw new MoneyError(`${value} is negative; a fee cannot be less than nothing`);
  }
  if (value > MAX_CENTAVOS) {
    throw new MoneyError(`${value} exceeds the maximum amount this system will represent`);
  }
  return value as Centavos;
}

export const ZERO = centavos(0);

/** Sums any number of amounts, refusing an overflow rather than wrapping. */
export function sum(amounts: readonly Centavos[]): Centavos {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new MoneyError('the total exceeds the range this system represents exactly');
    }
  }
  return centavos(total);
}

export function subtract(from: Centavos, amount: Centavos): Centavos {
  // Refuses rather than returning a negative: a balance below zero is an
  // overpayment, which is a different fact needing a different answer, and
  // silently representing it as a negative balance is how a refund becomes a
  // credit nobody notices.
  if (amount > from) {
    throw new MoneyError(`cannot subtract ${amount} from ${from}: the result would be negative`);
  }
  return centavos(from - amount);
}

/**
 * Parses a value that came from outside — a wire payload, a database row, a
 * spreadsheet — refusing anything that is not already whole centavos.
 *
 * Deliberately does not accept a peso string like "1,234.50". Converting pesos
 * to centavos in one place is fine; doing it implicitly wherever a value is
 * read is how a fee ends up multiplied by a hundred.
 */
export function parseCentavos(value: unknown): Centavos {
  if (typeof value === 'number') return centavos(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return centavos(Number(value));
  throw new MoneyError(`${JSON.stringify(value)} is not a whole number of centavos`);
}

/** For display only. Never used to compute anything. */
export function formatPeso(amount: Centavos): string {
  const pesos = Math.floor(amount / 100);
  const remainder = amount % 100;
  return `PHP ${pesos.toLocaleString('en-PH')}.${remainder.toString().padStart(2, '0')}`;
}
