/**
 * All 34 barangays of Castilla, Sorsogon (PSGC) — the one municipality a
 * business filed with eBPCO must be located in (see `businessShape` in
 * `businesses.controller.ts`).
 *
 * The backend had no canonical source at all until now — both frontends
 * (`eBPCO-Web`'s `castilla-barangays.ts`, `eBPCO-Information-Portal-Website`'s
 * `ph-reference-data.ts`) hand-maintain their own identical copy of this same
 * 34-name list for their dropdowns, and nothing stopped a client from
 * submitting anything else: `barangay` was plain free text here
 * (`z.string().min(1).max(120)`), and the backend's own seed/test fixtures
 * already used values outside this set ("Poblacion Uno", a "Poblacion" paired
 * with city "Cabuyao"). This is the list every BUSINESS address's `barangay`
 * is now validated against — kept identical to the two frontends' copies on
 * purpose; a name added or renamed here needs the same edit made in both.
 *
 * Deliberately NOT used for an APPLICANT's own personal address (`applicant`
 * schemas in `auth.controller.ts`, `staff-applications.controller.ts`,
 * `staff-citizens.controller.ts`) — a citizen filing with this LGU is not
 * required to live in Castilla themselves, only the business is.
 */
export const CASTILLA_BARANGAYS = [
  'Amomonting', 'Bagalayag', 'Bagong Sirang', 'Bonga', 'Buenavista', 'Burabod', 'Caburacan',
  'Canjela', 'Cogon', 'Cumadcad', 'Dangcalan', 'Dinapa', 'La Union', 'Libtong', 'Loreto',
  'Macalaya', 'Maracabac', 'Mayon', 'Maypangi', 'Milagrosa', 'Miluya', 'Monte Carmelo', 'Oras',
  'Pandan', 'Poblacion', 'Quirapi', 'Saclayan', 'Salvacion', 'San Isidro', 'San Rafael',
  'San Roque', 'San Vicente', 'Sogoy', 'Tomalaytay',
] as const;
