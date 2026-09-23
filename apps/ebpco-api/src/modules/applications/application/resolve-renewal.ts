import { SqlClient } from '../../../persistence/sql-client';

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
      reason: 'not-a-renewal' | 'renewal-needs-a-permit' | 'permit-not-found' | 'renewal-reference-conflict';
      detail: string;
    }
> {
  const { action, permitNumber, priorPermitClaim, applicantId, tolerateNoReferenceYet } = options;

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

  const found = await tx.query<{ application_id: string }>(
    `select g.application_id
       from generated_permits g
       join applications a on a.id = g.application_id
      where g.permit_number = $1 and a.applicant_id = $2`,
    [permitNumber, applicantId],
  );
  const permitId = found.rows[0]?.application_id;
  if (permitId === undefined) {
    // One answer for "no such permit" and "not yours", deliberately. Telling
    // them apart would let anyone test whether a permit number exists.
    return {
      ok: false, reason: 'permit-not-found',
      detail: `No permit numbered "${permitNumber}" is registered to this applicant.`,
    };
  }
  return { ok: true, permitId, priorPermitClaim: null };
}
