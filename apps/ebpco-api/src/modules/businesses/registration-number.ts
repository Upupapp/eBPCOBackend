import { z } from 'zod';

import { SqlClient } from '../../persistence/sql-client';

/**
 * A business's DTI / SEC / CDA registration number (QA finding TC-24,
 * 2026-10-03: "x" was accepted, printed on the business and shown to staff,
 * and could never be corrected).
 *
 * Loose on purpose: the three registries number differently (a DTI business
 * name number is digits; SEC and CDA numbers mix letters, digits and hyphens),
 * and this service is not the registry. It refuses what cannot be one: too
 * short or long, characters none of them use, or fewer than four digits.
 * Null when the number is acceptable.
 */
export function registrationNumberProblem(value: string): string | null {
  const number = value.trim();
  if (number.length < 5 || number.length > 40) {
    return 'Enter the DTI, SEC or CDA registration number exactly as it appears on the certificate (5 to 40 characters).';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/.test(number)) {
    return 'A registration number has only letters, numbers, spaces, hyphens, slashes and periods.';
  }
  if ((number.match(/\d/g) ?? []).length < 4) {
    return 'A registration number has at least 4 digits. Copy it from the DTI, SEC or CDA certificate.';
  }
  return null;
}

/** Registered on a real day, and not in the future. */
export function registrationDateProblem(value: string, today: Date = new Date()): string | null {
  const day = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    return 'Enter the registration date as it appears on the certificate.';
  }
  if (value > today.toISOString().slice(0, 10)) return 'The registration date cannot be in the future.';
  return null;
}

export const registrationNumberField = z.string().superRefine((value, ctx) => {
  const problem = registrationNumberProblem(value);
  if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
}).transform((value) => value.trim());

export const registrationDateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .superRefine((value, ctx) => {
    const problem = registrationDateProblem(value);
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

/**
 * Whether an application filed under this business has reached the office.
 * Until one has, the owner may correct the registration facts they typed;
 * after, the office relies on them, and the office corrects them.
 */
export async function filedUnder(db: SqlClient, businessId: string): Promise<boolean> {
  const found = await db.query(
    `select 1 from applications where business_id = $1 and lifecycle_status <> 'Draft' limit 1`, [businessId],
  );
  return found.rows.length > 0;
}
