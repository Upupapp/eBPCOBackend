/**
 * The permit names citizens see, and how they relate to the keys this service
 * stores.
 *
 * ── There are TWO vocabularies, not one in three places ─────────────────
 *
 * The admin portal and the public information portal both publish a 19-name
 * catalogue -- 'Building Permit – New Construction', 'Civil / Structural
 * Permit'. This service keys its records on 17 shorter internal names --
 * 'New Construction', 'Civil/Structural' -- in `permit_types`.
 *
 * They are not a mismatch to be repaired. The published names are what a
 * citizen reads on a portal; the internal keys are a primary key referenced by
 * applications, charter entries, fee schedules and requirements. What was
 * missing is the relationship BETWEEN them, which is what this file is.
 *
 * ── What is asserted, and what is deliberately not ──────────────────────
 *
 * Fifteen of the seventeen keys map to exactly one published name. Two do not,
 * and four published names have no key. Those are listed with reasons rather
 * than guessed at, because a wrong mapping here silently mislabels a citizen's
 * permit -- and the two hardest cases are genuine questions about what this
 * LGU issues, not naming problems.
 */

/** A published name, exactly as the admin and the portal both spell it. */
export type PublishedPermitName = string;

/**
 * Fifteen unambiguous pairs, internal key to published name.
 *
 * Every one is a spelling difference and nothing more: the published name adds
 * the word Permit, spaces the slashes, or prefixes 'Building Permit – '.
 */
export const PUBLISHED_NAME_BY_KEY: Readonly<Record<string, PublishedPermitName>> = {
  'New Construction': 'Building Permit – New Construction',
  Renovation: 'Building Permit – Renovation / Alteration',
  'Addition/Extension': 'Building Permit – Addition / Extension',
  Demolition: 'Demolition Permit',
  Architectural: 'Architectural Permit',
  'Civil/Structural': 'Civil / Structural Permit',
  Electrical: 'Electrical Permit',
  Mechanical: 'Mechanical Permit',
  Plumbing: 'Plumbing Permit',
  Electronics: 'Electronics Permit',
  'Interior Design': 'Interior Design Permit',
  Fencing: 'Fencing Permit',
  Sign: 'Sign Permit',
  Excavation: 'Excavation Permit',
  'Certificate of Occupancy': 'Certificate of Occupancy',
};

/**
 * Internal keys with no agreed published name, and why.
 *
 * A register, checked both ways: an entry that gains a mapping has to leave
 * this list, or the list becomes a record of things that used to be unclear.
 */
export const KEYS_WITHOUT_A_PUBLISHED_NAME: Readonly<Record<string, string>> = {
  'Sanitary/Plumbing':
    'a stale COMBINED key. Resolved on the documents rather than by ruling: the two forms this '
    + 'LGU publishes are NBC FORM NO. A-05 (Sanitary Permit, under the Code on Sanitation of the '
    + 'Philippines) and NBC FORM NO. A-06 (Plumbing Permit, under the Revised Plumbing Code) -- '
    + 'two distinct forms under PD 1096, certified by different licensed professionals, and the '
    + 'same pair appears across unrelated LGUs. So this key means Sanitary and should be renamed '
    + "to 'Sanitary'. NOT mapped here because the rename is a primary-key migration: permit_type "
    + 'is referenced by applications, charter entries, fee schedules and requirements, and this '
    + "key carries the 'SPP' prefix already printed on issued permit numbers. Mapping it without "
    + 'renaming would leave two names for one permit.',
  'Business Permit':
    'a different service domain. This service models Business Permit and Construction Permit; '
    + 'the published catalogue is building permits only, so there is no counterpart to map to '
    + 'and inventing one would put a business permit in a building-permit catalogue.',
};

/**
 * Published names this service has no key for, and why.
 *
 * These are the more consequential half: each is a permit a citizen can read
 * about on the portal and cannot file here.
 */
export const PUBLISHED_NAMES_WITHOUT_A_KEY: Readonly<Record<PublishedPermitName, string>> = {
  'Zoning / Locational Clearance':
    'issued by the Zoning Section of the Municipal Planning and Development Office, which this '
    + 'service does not model as an issuing office. A citizen can read about it and cannot file '
    + 'it here.',
  'FSEC for Building Permit (BFP)':
    'issued by the Bureau of Fire Protection, a NATIONAL agency with no municipal office record '
    + '-- the portal deliberately carries a null issuing office for it.',
  'FSIC for Occupancy Permit (BFP)': 'same as FSEC above -- Bureau of Fire Protection',
  'Sanitary Permit':
    "unclaimed only because 'Sanitary/Plumbing' above is unresolved. This entry disappears the "
    + 'moment that ruling is made.',
};

/**
 * The name a citizen would recognise, for an internal key.
 *
 * `null` rather than the key itself when there is no agreed published name.
 * Falling back to the key would put an internal identifier in a field a client
 * binds to its published vocabulary -- which is the defect this whole function
 * exists to remove, reintroduced one layer down and harder to see.
 *
 * A client reading `null` knows the backend has no published name for this
 * permit. A client reading 'Sanitary/Plumbing' in a field promising a published
 * name has been told something false.
 */
export function publishedNameFor(key: string): string | null {
  return PUBLISHED_NAME_BY_KEY[key] ?? null;
}
