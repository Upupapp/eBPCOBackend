/**
 * All 34 barangays of Castilla, Sorsogon (PSGC) — the one municipality a
 * business filed with eBPCO must be located in (see `businessShape` in
 * `businesses.controller.ts`).
 *
 * The backend had no canonical source at all until 2026-09-25 — both
 * frontends (`eBPCO-Web`'s `castilla-barangays.ts`,
 * `eBPCO-Information-Portal-Website`'s `ph-reference-data.ts`) hand-maintain
 * their own identical copy of this same 34-name list for their dropdowns,
 * and nothing stopped a client from submitting anything else: `barangay` was
 * plain free text here (`z.string().min(1).max(120)`), and the backend's own
 * seed/test fixtures already used values outside this set ("Poblacion Uno",
 * a "Poblacion" paired with city "Cabuyao"). This is the list every address
 * is validated against — kept identical to the two frontends' copies on
 * purpose; a name added or renamed here needs the same edit made in both.
 *
 * Owner decision, 2026-09-25: an APPLICANT's own personal address is ALSO
 * Castilla-only now, same as a business's — matching what the Citizen
 * Portal's own sign-up form already does (its City/Province fields are each
 * a single hardcoded "Castilla"/"Sorsogon" option; see that repo's
 * `ph-reference-data.ts`). Originally left as free text here on the theory
 * that a citizen filing with this LGU need not live in Castilla themselves —
 * overridden by the owner in favor of matching sign-up's existing behavior
 * everywhere else this data is collected or corrected: `auth.controller.ts`
 * (`/auth/register`, `PATCH /me`), `staff-applications.controller.ts` (walk-in
 * intake's `applicant.barangay`), `staff-citizens.controller.ts` (an
 * officer's rectification of a citizen's own record).
 */
export const CASTILLA_BARANGAYS = [
  'Amomonting', 'Bagalayag', 'Bagong Sirang', 'Bonga', 'Buenavista', 'Burabod', 'Caburacan',
  'Canjela', 'Cogon', 'Cumadcad', 'Dangcalan', 'Dinapa', 'La Union', 'Libtong', 'Loreto',
  'Macalaya', 'Maracabac', 'Mayon', 'Maypangi', 'Milagrosa', 'Miluya', 'Monte Carmelo', 'Oras',
  'Pandan', 'Poblacion', 'Quirapi', 'Saclayan', 'Salvacion', 'San Isidro', 'San Rafael',
  'San Roque', 'San Vicente', 'Sogoy', 'Tomalaytay',
] as const;

/** The one City/Municipality and Province every address in this system is now pinned to — see the module comment above. */
export const CASTILLA_CITY = 'Castilla';
export const CASTILLA_PROVINCE = 'Sorsogon';
