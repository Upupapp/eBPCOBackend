import { SqlClient } from '../../../persistence/sql-client';

/**
 * An Official Receipt number, as a cashier types it off the receipt (QA
 * findings TC-03 and TC-08, 2026-10-03: "abc" was accepted and printed on the
 * record, and an empty one was answered "Please give a reason").
 *
 * The check is deliberately loose about format: the Municipality's receipts
 * are pre-printed accountable forms whose series this service does not know,
 * so it does not invent one. It refuses what cannot be a receipt number: too
 * long, characters no receipt carries, or fewer than four digits.
 * Null when the number is acceptable.
 */
export function officialReceiptProblem(value: string): string | null {
  const number = value.trim();
  if (number.length === 0) return 'Enter the Official Receipt number, exactly as printed on the receipt.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/.test(number)) {
    return 'An Official Receipt number has only letters, numbers, spaces, hyphens, slashes and periods.';
  }
  if ((number.match(/\d/g) ?? []).length < 4) {
    return 'An Official Receipt number has at least 4 digits. Copy it exactly as printed on the receipt.';
  }
  if (number.length > 40) return 'An Official Receipt number is at most 40 characters long.';
  return null;
}

/**
 * The application whose payment already carries this receipt number, if any
 * other payment does: one receipt is one payment, so a second use is a typing
 * mistake or a reused stub, and either way not to be recorded. Compared
 * without case or surrounding spaces.
 */
export async function receiptAlreadyUsed(
  db: SqlClient, officialReceiptNumber: string, exceptPaymentId: string | null,
): Promise<string | null> {
  const found = await db.query<{ reference_number: string }>(
    `select a.reference_number
       from payments p join applications a on a.id = p.application_id
      where upper(trim(p.official_receipt_number)) = upper(trim($1))
        and ($2::uuid is null or p.id <> $2)
      limit 1`,
    [officialReceiptNumber, exceptPaymentId],
  );
  return found.rows[0]?.reference_number ?? null;
}

export function receiptInUseDetail(officialReceiptNumber: string, reference: string): string {
  return `Official Receipt No. ${officialReceiptNumber.trim()} is already recorded on the payment for ${reference}. `
    + 'Check the number on the receipt.';
}
