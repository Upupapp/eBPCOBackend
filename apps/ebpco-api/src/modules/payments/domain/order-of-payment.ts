import { Centavos, centavos, sum } from './money';

/**
 * The Order of Payment: the sole authoritative source of an amount owed.
 *
 * Six lines, fixed, because they are the admin's own `AssessmentFeeCentavos`
 * and TAB 01 reconciled both clients onto them. Each carries the statutory or
 * ordinance basis it rests on — an applicant handed a figure with no authority
 * behind it has no way to question it, and RA 11032's transparency requirement
 * is not satisfied by a total.
 */

export const FEE_LINES = [
  'filing', 'processing', 'architectural', 'structural', 'electrical', 'others',
] as const;

export type FeeLine = (typeof FEE_LINES)[number];

export interface FeeLineItem {
  readonly line: FeeLine;
  readonly amount: Centavos;
  /** The ordinance, section or issuance this line rests on. */
  readonly basis: string;
}

export interface OrderOfPaymentDraft {
  readonly applicationId: string;
  readonly items: readonly FeeLineItem[];
  readonly feeScheduleVersion: string;
  readonly dueDate: string | null;
}

export interface OrderOfPayment extends OrderOfPaymentDraft {
  readonly id: string;
  readonly number: string;
  readonly assessedAt: Date;
  readonly assessedBy: string;
  readonly total: Centavos;
  readonly supersedesId: string | null;
  readonly supersededReason: string | null;
}

export class AssessmentError extends Error {}

/**
 * Builds the six-line breakdown, filling absent lines with an explicit zero.
 *
 * A line that does not apply is `0`, never missing: the contract requires all
 * six, so a client never has to decide what an absent line means, and an
 * applicant reading the breakdown sees that architectural fees were considered
 * and were nil rather than wondering whether they were forgotten.
 */
export function buildLineItems(
  amounts: Partial<Record<FeeLine, number>>,
  bases: Partial<Record<FeeLine, string>>,
): FeeLineItem[] {
  return FEE_LINES.map((line) => {
    const amount = centavos(amounts[line] ?? 0);
    const basis = bases[line]?.trim() ?? '';

    // A non-zero charge with no stated authority is a figure the applicant
    // cannot question.
    if (amount > 0 && basis === '') {
      throw new AssessmentError(
        `the ${line} fee is ${amount} centavos but names no ordinance or issuance it rests on`,
      );
    }
    return { line, amount, basis };
  });
}

export function totalOf(items: readonly FeeLineItem[]): Centavos {
  const seen = new Set(items.map((item) => item.line));
  if (seen.size !== FEE_LINES.length) {
    throw new AssessmentError(
      `an Order of Payment must carry all ${FEE_LINES.length} lines; got ${seen.size}`,
    );
  }
  return sum(items.map((item) => item.amount));
}

/**
 * An Order with no money on it is not an assessment.
 *
 * Issuing a zero Order would tell an applicant they may pay nothing and
 * proceed, which is a different decision — a fee waiver — and one that needs
 * its own authority and its own record rather than an Order of Payment that
 * happens to total nothing.
 */
export function assertIssuable(items: readonly FeeLineItem[]): Centavos {
  const total = totalOf(items);
  if (total === 0) {
    throw new AssessmentError(
      'an Order of Payment totalling zero is not an assessment; a waiver is a separate decision',
    );
  }
  return total;
}

/**
 * Whether a submitted payment settles an Order.
 *
 * Decision E-8: partial payment is NOT accepted, so this is exact equality
 * rather than a threshold. Under- and overpayment are both reported to the
 * officer rather than auto-decided, because an applicant who paid PHP 12,602.00
 * against PHP 12,602.50 has made a mistake worth a conversation, and one who
 * paid too much is owed a refund — neither is something software should settle.
 */
export type SettlementCheck =
  | { readonly settles: true }
  | { readonly settles: false; readonly reason: 'underpaid' | 'overpaid'; readonly differenceCentavos: number };

export function checkSettles(total: Centavos, paid: Centavos): SettlementCheck {
  if (paid === total) return { settles: true };
  return {
    settles: false,
    reason: paid < total ? 'underpaid' : 'overpaid',
    differenceCentavos: Math.abs(paid - total),
  };
}
