/**
 * The 19 canonical permit names, verbatim and in order.
 *
 * This backend is the THIRD holder of this vocabulary: the eBPCO Web Admin
 * keys its entire transaction system on the same strings (its `PermitType`
 * union), and the public portal publishes them. The three currently agree, and
 * until now nothing enforced that — the portal's own test named 'groups all 19
 * permit types' asserts only that its data file equals itself, which is true of
 * any data file.
 *
 * NOT NORMALISED, deliberately. 'Civil / Structural Permit' has spaces around
 * its slash, and the Building Permit entries use an EN DASH (U+2013), not a
 * hyphen. Both are load-bearing: a client sending the hyphen version to the
 * admin system is sending a permit type that does not exist.
 *
 * Order is part of the contract too — it is the order the catalogue is
 * published in, and the parity test compares by index, not as a set.
 */
export const CANONICAL_PERMIT_NAMES = [
  'Building Permit – New Construction',
  'Building Permit – Renovation / Alteration',
  'Building Permit – Addition / Extension',
  'Demolition Permit',
  'Zoning / Locational Clearance',
  'Architectural Permit',
  'Civil / Structural Permit',
  'Electrical Permit',
  'Mechanical Permit',
  'Sanitary Permit',
  'Plumbing Permit',
  'Electronics Permit',
  'Interior Design Permit',
  'Fencing Permit',
  'Sign Permit',
  'Excavation Permit',
  'FSEC for Building Permit (BFP)',
  'Certificate of Occupancy',
  'FSIC for Occupancy Permit (BFP)',
] as const;

export type CanonicalPermitName = (typeof CANONICAL_PERMIT_NAMES)[number];
