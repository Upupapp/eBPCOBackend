import { StaffAccess } from '../../identity/domain/staff-access';
import { Caller } from './application';

/**
 * Which permit types a caller's rows may be drawn from.
 *
 * The companion to `visibleStatusesFor`, and the same argument: least privilege
 * expressed as a ROW FILTER rather than a UI decision. Hiding an application in
 * the client would still have sent it, and — the reason this matters more than
 * it looks — it would still have COUNTED it. An officer who can see that the
 * queue holds 412 applications when 38 are theirs has learned the size of every
 * other office's workload, and can watch it change.
 *
 * So this returns a predicate the query applies, never a list the caller
 * filters afterwards.
 */
export type FormFilter =
  /** An applicant, or a caller whose authority does not run through the allow-list. */
  | { readonly kind: 'all' }
  /** Staff: exactly these permit types, and none if the list is empty. */
  | { readonly kind: 'permit-types'; readonly permitTypes: readonly string[] };

/**
 * `null` access means an account with no assignment, which reaches nothing.
 *
 * Deliberately NOT the same as `undefined` meaning "not staff": an applicant
 * reads their own records through ownership and never through this list, and
 * collapsing the two would either lock applicants out or hand unassigned
 * officers everything.
 */
export function formFilterFor(caller: Caller, access: StaffAccess | null): FormFilter {
  if (caller.kind !== 'staff') return { kind: 'all' };
  if (access === null) return { kind: 'permit-types', permitTypes: [] };
  return { kind: 'permit-types', permitTypes: access.permitTypes };
}

/**
 * The predicate, as SQL plus its parameter.
 *
 * Returns the fragment rather than a whole query so it can be dropped into the
 * queue, the evaluations worklist, the detail read, documents, payments and the
 * metrics — which is the point. A filter applied in five places by hand is a
 * filter missing from the sixth.
 *
 * `false` for an empty list rather than `in ()`, which is a syntax error in
 * PostgreSQL and would turn "this officer reaches nothing" into a 500.
 */
export function formFilterSql(
  filter: FormFilter, column: string, parameter: number,
): { sql: string; params: readonly unknown[] } {
  if (filter.kind === 'all') return { sql: 'true', params: [] };
  if (filter.permitTypes.length === 0) return { sql: 'false', params: [] };
  return {
    sql: `${column} = any($${String(parameter)}::text[])`,
    params: [[...filter.permitTypes]],
  };
}

// `mayActOnPermitType` lived here and was removed: it asked the same question as
// `mayWorkOn` in identity/domain/staff-access.ts, on a different type, and two
// names for one rule is how the two come to disagree. The write path checks one
// indexed row inside its transaction; `mayWorkOn` is where the semantics are
// stated and tested.
