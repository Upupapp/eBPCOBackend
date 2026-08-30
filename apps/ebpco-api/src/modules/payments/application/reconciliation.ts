import { SqlClient } from '../../../persistence/sql-client';
import { Centavos, centavos, parseCentavos, sum } from '../domain/money';

/**
 * Reconciling what the system says was collected against what the Treasury
 * actually holds.
 *
 * The report exists because those two are different records kept by different
 * offices, and the only way anyone finds out they disagree is by comparing
 * them. A system that reports only its own totals is reporting that it agrees
 * with itself.
 */

export interface CollectionRecord {
  readonly officialReceiptNumber: string;
  readonly amountCentavos: number;
}

export interface Discrepancy {
  readonly kind: 'missing-from-treasury' | 'missing-from-system' | 'amount-differs';
  readonly officialReceiptNumber: string;
  readonly systemCentavos: number | null;
  readonly treasuryCentavos: number | null;
}

export interface ReconciliationReport {
  readonly from: string;
  readonly to: string;
  readonly verifiedPaymentCount: number;
  readonly systemTotalCentavos: Centavos;
  readonly treasuryTotalCentavos: Centavos;
  readonly differenceCentavos: number;
  readonly discrepancies: readonly Discrepancy[];
  readonly balanced: boolean;
}

export async function reconcile(
  db: SqlClient,
  options: { from: string; to: string; treasury: readonly CollectionRecord[] },
): Promise<ReconciliationReport> {
  const { from, to, treasury } = options;

  const verified = await db.query<{ official_receipt_number: string; amount_centavos: number }>(
    `select official_receipt_number, amount_centavos
       from payments
      where verified_at >= $1 and verified_at < $2 and status = 'Paid'
      order by verified_at`,
    [from, to],
  );

  const system = new Map(
    verified.rows.map((row) => [row.official_receipt_number, parseCentavos(row.amount_centavos)]),
  );
  const treasuryByReceipt = new Map(
    treasury.map((record) => [record.officialReceiptNumber, parseCentavos(record.amountCentavos)]),
  );

  const discrepancies: Discrepancy[] = [];

  for (const [receipt, amount] of system) {
    const counterpart = treasuryByReceipt.get(receipt);
    if (counterpart === undefined) {
      // The system says money arrived and the Treasury has no record of it.
      discrepancies.push({
        kind: 'missing-from-treasury', officialReceiptNumber: receipt,
        systemCentavos: amount, treasuryCentavos: null,
      });
    } else if (counterpart !== amount) {
      discrepancies.push({
        kind: 'amount-differs', officialReceiptNumber: receipt,
        systemCentavos: amount, treasuryCentavos: counterpart,
      });
    }
  }

  for (const [receipt, amount] of treasuryByReceipt) {
    if (!system.has(receipt)) {
      // The Treasury holds money this system never recorded — which usually
      // means an applicant paid and the proof was never submitted or verified.
      discrepancies.push({
        kind: 'missing-from-system', officialReceiptNumber: receipt,
        systemCentavos: null, treasuryCentavos: amount,
      });
    }
  }

  const systemTotal = sum([...system.values()]);
  const treasuryTotal = sum([...treasuryByReceipt.values()]);

  return {
    from, to,
    verifiedPaymentCount: system.size,
    systemTotalCentavos: systemTotal,
    treasuryTotalCentavos: treasuryTotal,
    differenceCentavos: systemTotal - treasuryTotal,
    discrepancies,
    // Balanced means every receipt matches, not merely that the totals do: two
    // offsetting errors sum to zero and are still two errors.
    balanced: discrepancies.length === 0 && systemTotal === treasuryTotal,
  };
}

export { centavos };
