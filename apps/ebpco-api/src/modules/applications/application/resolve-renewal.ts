import { SqlClient } from '../../../persistence/sql-client';

/** Every way a Renewal/Amendment reference can be refused — see resolveRenewal(). */
export type RenewalRefusal =
  | 'not-a-renewal' | 'renewal-needs-a-permit' | 'permit-not-found' | 'renewal-reference-conflict'
  | 'permit-business-mismatch' | 'permit-type-mismatch';

/**
 * The permit a Renewal or Amendment is about — a verified link, an
 * unverified claim, or neither, depending which (if either) field the
 * caller supplied.
 *
 * `permitNumber` (→ `permitId`) is theirs, or nothing: renewing someone
 * else's permit would put their particulars on this applicant's filing, the
 * same rule the business check enforces one field away — an applicant may
 * only build on records that are already theirs. Resolved from the permit
 * NUMBER the applicant quotes, because that is what is printed on the
 * instrument in their hand; the column stores the key.
 *
 * Theirs is necessary but not sufficient: the permit must also have been
 * issued to the BUSINESS this filing names, and be the same PERMIT TYPE.
 * Renewing the bakery's permit on the hardware store's filing, or quoting a
 * Fencing Permit on a Building Permit renewal, links the officer to the
 * wrong original just as surely as a stranger's number would — and before
 * this check the only thing that caught it was an officer noticing.
 *
 * The number is compared trimmed and case-insensitively. Every number eBPCO
 * issues is `SERIES-YYYY-NNNNNN` in capitals (migration 010), so
 * `bp-2026-000001` typed on a phone keyboard is the same permit, not a
 * missing one — and upper-casing both sides, rather than only the input,
 * keeps it right for any number not in that shape.
 *
 * `priorPermitClaim` exists for the permit eBPCO never issued: launched
 * into a Municipality with decades of paper permits already outstanding, so
 * "no matching `generated_permits` row" is the COMMON case for a real
 * renewal, not a fraud signal. Accepted as-is — there is nothing to
 * resolve it against — and never promoted to a verified `permitId`. What
 * makes it judgeable is the proof document `submit()` requires alongside
 * it, not anything this function checks.
 *
 * Shared by `SubmissionService` (citizen self-service and staff walk-in
 * filing) and `RecordsService` (staff correcting a filed record's, or a
 * Draft's, claimed reference) — the resolution rule has nothing specific to
 * either caller, only to what was actually given.
 */
export async function resolveRenewal(
  tx: SqlClient,
  options: {
    action: string; permitNumber: string | null; priorPermitClaim: string | null; applicantId: string;
    /** The business this filing names — the permit must have been issued to the same one. */
    businessId: string | null;
    /**
     * The permit type being applied for — the permit must be of the same
     * type. Null only from the wizard's pre-check in the portal's generic
     * flow, which does not know the type until the permit tells it; filing
     * always names one.
     */
    permitType: string | null;
    /**
     * A Draft may legitimately name neither reference yet — the citizen
     * has picked Renewal/Amendment but hasn't settled on which permit.
     * Every OTHER refusal below still applies to a draft: a bad number,
     * a New application naming one, both given at once — those are
     * errors in what was actually given, not a gap still to be filled.
     */
    tolerateNoReferenceYet?: boolean;
  },
): Promise<
  | { ok: true; permitId: string | null; priorPermitClaim: string | null }
  | {
      ok: false;
      reason: RenewalRefusal;
      detail: string;
      /** On `permit-type-mismatch` only: what the quoted permit actually is. */
      issuedAs?: string;
    }
> {
  const { action, priorPermitClaim, applicantId, businessId, permitType, tolerateNoReferenceYet } = options;
  const permitNumber = options.permitNumber === null ? null : options.permitNumber.trim();

  if (action === 'New') {
    if (permitNumber !== null || priorPermitClaim !== null) {
      return {
        ok: false, reason: 'not-a-renewal',
        detail: 'A New application does not renew a permit. Choose Renewal or Amendment, or omit it.',
      };
    }
    return { ok: true, permitId: null, priorPermitClaim: null };
  }

  if (permitNumber !== null && priorPermitClaim !== null) {
    // Two different claims about which one permit this is — the applicant
    // (or the officer keying it in) must pick one, not have the server
    // silently prefer one over the other.
    return {
      ok: false, reason: 'renewal-reference-conflict',
      detail: 'Choose either a permit already on file or a prior permit claim, not both.',
    };
  }

  if (priorPermitClaim !== null) return { ok: true, permitId: null, priorPermitClaim };

  if (permitNumber === null) {
    // A draft may say "Renewal" and stop there — the citizen hasn't
    // settled on which permit yet. A real filing may not: the defect the
    // whole column exists to prevent is an officer opening a renewal and
    // having to find the original by searching a name.
    if (tolerateNoReferenceYet) return { ok: true, permitId: null, priorPermitClaim: null };
    return {
      ok: false, reason: 'renewal-needs-a-permit',
      detail: `A ${action} has to say which permit it is about — quote the permit number, or, if it predates `
        + 'eBPCO, claim it as a prior permit and attach proof.',
    };
  }

  const found = await tx.query<{ application_id: string; business_id: string | null; permit_type: string }>(
    `select g.application_id, a.business_id, a.permit_type
       from generated_permits g
       join applications a on a.id = g.application_id
      where upper(g.permit_number) = upper($1) and a.applicant_id = $2`,
    [permitNumber, applicantId],
  );
  const permit = found.rows[0];
  if (permit === undefined) {
    // One answer for "no such permit" and "not yours", deliberately. Telling
    // them apart would let anyone test whether a permit number exists.
    return {
      ok: false, reason: 'permit-not-found',
      detail: `No permit numbered "${permitNumber}" is registered to this applicant.`,
    };
  }
  // Past this point the permit is the applicant's own, so saying WHY it does
  // not fit discloses nothing they could not read off their own permit.
  if (permit.business_id !== businessId) {
    return {
      ok: false, reason: 'permit-business-mismatch',
      detail: `Permit "${permitNumber}" was issued to a different business than the one selected.`,
    };
  }
  if (permitType !== null && permit.permit_type !== permitType) {
    return {
      ok: false, reason: 'permit-type-mismatch',
      detail: `Permit "${permitNumber}" is a ${permit.permit_type}, not a ${permitType}.`,
      issuedAs: permit.permit_type,
    };
  }
  return { ok: true, permitId: permit.application_id, priorPermitClaim: null };
}
