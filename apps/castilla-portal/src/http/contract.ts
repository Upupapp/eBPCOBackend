import { z } from 'zod';

/**
 * The wire contract, defined once.
 *
 * These schemas are both the OpenAPI source (scripts/emit-openapi.ts renders
 * them) and the assertion the tests validate real responses against, so the
 * document and the behaviour cannot drift: there is only one definition.
 *
 * `.strict()` throughout. A response carrying a key the contract does not
 * declare is a failure here, not a tolerated extra — that is how a withheld
 * field leaks.
 */
export const officeSummarySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  shortDescription: z.string().min(1),
}).strict();

export const officeHeadSchema = z.object({
  name: z.string().min(1),
  position: z.string().min(1),
  /**
   * AUTHORED, never derived — which is why it is served rather than left to a
   * client. Deriving initials means handling honorifics (Atty., Dr.),
   * generational suffixes (Jr.), post-nominals after a comma (, RSW) and
   * quoted nicknames: Isagani "Bong" B. Mendoza is IM, not IBM.
   *
   * Optional only because an office head written inline on the office (rather
   * than being an elected official) has none authored YET — the source data
   * has to gain them. Absent means "nobody has written these down", never
   * "this person has no initials".
   */
  initials: z.string().min(1).optional(),
}).strict();

const officeLinkSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
}).strict();

export const officeDetailSchema = officeSummarySchema.extend({
  aboutText: z.string().min(1),
  services: z.array(z.string().min(1)),
  // Optional means ABSENT, never null. `.optional()` without `.nullable()` is
  // the contract stating that an unconfirmed head has no key at all.
  head: officeHeadSchema.optional(),
  contact: z.record(z.string(), z.string().min(1)).optional(),
  relatedOffices: z.array(officeLinkSchema),
  issuedPermits: z.array(officeLinkSchema),
}).strict();

export const officeListSchema = z.object({
  offices: z.array(officeSummarySchema),
  /**
   * Every category, with its label, in the order the LGU wants them read.
   *
   * Same shape as `PermitCatalogue.groups` deliberately: one shape for "a list
   * of labelled groups" rather than two spellings of the idea.
   *
   * ALWAYS the full list, even when `?category=` filtered the offices — a
   * filter bar has to show the options that are not currently selected.
   */
  categories: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
  }).strict()),
}).strict();

export type OfficeListResponse = z.infer<typeof officeListSchema>;
export type OfficeDetailResponse = z.infer<typeof officeDetailSchema>;

export const profileFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  // Present only for a genuine magnitude. A ZIP code carries no count, so the
  // contract cannot describe one as carrying an optional zero.
  count: z.number().optional(),
  countSuffix: z.string().min(1).optional(),
  countDecimals: z.number().int().min(0).optional(),
}).strict();

export const municipalityProfileSchema = z.object({
  /**
   * CONFIRMED FIELDS ONLY. A guarantee, not an accident of the current query:
   * `municipality.repository.ts` filters on `fs.state = 'confirmed'`, so an
   * unconfirmed field has never been able to reach this array.
   *
   * Said here because the website lane was filtering again on its side to
   * honour the same rule, which is a rule enforced twice and therefore
   * enforceable in neither place once the two disagree. Clients may render
   * everything they receive.
   */
  fields: z.array(profileFieldSchema),
}).strict();

export const officialSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  position: z.string().min(1),
  office: z.string().min(1),
  initials: z.string().min(1),
  /**
   * Which seat this official holds, so a client can group them without
   * matching on `position`. The position is prose written for a citizen to
   * read; the role is the fact underneath it.
   *
   * `sb-ex-officio` covers both ex-officio seats (the ABC president and the SK
   * federation president). If they ever need telling apart, that is an
   * additional value here, not a different shape.
   */
  role: z.enum(['mayor', 'vice-mayor', 'sb-member', 'sb-ex-officio']),
  photoUrl: z.string().min(1).optional(),
}).strict();

export const officialListSchema = z.object({
  officials: z.array(officialSchema),
}).strict();

export type MunicipalityProfileResponse = z.infer<typeof municipalityProfileSchema>;
export type OfficialListResponse = z.infer<typeof officialListSchema>;

/**
 * A permit's confirmation state travels WITH the record rather than gating it.
 * All 19 are 'pending' today, and withholding them would publish an empty
 * catalogue — a worse lie than an honest 'not yet verified'.
 */
export const permitSummarySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  confirmationState: z.enum(['pending', 'confirmed']),
}).strict();

export const permitCatalogueSchema = z.object({
  groups: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    permits: z.array(permitSummarySchema),
  }).strict()),
}).strict();

export const permitDetailSchema = permitSummarySchema.extend({
  group: z.object({ id: z.string().min(1), label: z.string().min(1) }).strict(),
  // `slug` is absent for the two BFP permits: the Bureau of Fire Protection is
  // a national agency with no municipal office page to link to.
  issuingOffice: z.object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
  }).strict(),
  requirements: z.array(z.string().min(1)),
  validity: z.string().min(1),
  processNote: z.string().min(1).optional(),
  formUrl: z.string().startsWith('/assets/permits/').optional(),
  checklistUrl: z.string().startsWith('/assets/permits/').optional(),
}).strict();

export type PermitCatalogueResponse = z.infer<typeof permitCatalogueSchema>;
export type PermitDetailResponse = z.infer<typeof permitDetailSchema>;

export const storedFormSchema = z.object({
  id: z.string().uuid(),
  familySlug: z.string().min(1),
  originalFilename: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  // Absent where the form prints no revision — 10 of the 13 do not, and an
  // invented 'v1' would be a claim the document does not make.
  revisionLabel: z.string().min(1).optional(),
  isCurrent: z.boolean(),
}).strict();

export const formListSchema = z.object({ forms: z.array(storedFormSchema) }).strict();
export const formRevisionsSchema = z.object({ revisions: z.array(storedFormSchema) }).strict();

export type FormListResponse = z.infer<typeof formListSchema>;

/**
 * `state` is DERIVED from the clock, never stored. 'scheduled' and 'expired'
 * are what time makes of a published announcement, so nothing has to run at the
 * appointed minute and no stopped job can leave a lapsed advisory on the site.
 */
export const announcementSummarySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  state: z.enum(['draft', 'scheduled', 'published', 'expired', 'withdrawn']),
}).strict();

export const announcementDetailSchema = announcementSummarySchema.extend({
  body: z.string().min(1),
  // Rendered server-side from the plain-text body. No markup is ever accepted.
  bodyHtml: z.string().min(1),
  attachment: z.object({
    familySlug: z.string().min(1),
    originalFilename: z.string().min(1),
    downloadUrl: z.string().startsWith('/forms/'),
  }).strict().optional(),
}).strict();

export const announcementListSchema = z.object({
  announcements: z.array(announcementSummarySchema),
  total: z.number().int().min(0),
  limit: z.number().int().positive(),
  offset: z.number().int().min(0),
}).strict();

export const announcementCountSchema = z.object({
  count: z.number().int().min(0),
}).strict();

export const searchResultSchema = z.object({
  entityType: z.enum(['office', 'permit']),
  slug: z.string().min(1),
  title: z.string().min(1),
  // Enough context to render a result row without a follow-up call.
  summary: z.string().min(1),
  facet: z.string().min(1).optional(),
  score: z.number(),
}).strict();

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  total: z.number().int().min(0),
}).strict();

export const contentPageSchema = z.object({
  key: z.enum(['history', 'vision', 'mission', 'seal-description', 'privacy-policy']),
  title: z.string().min(1),
  body: z.string().min(1),
  state: z.enum(['pending', 'confirmed']),
  // Distinct from `state`: a page can be an honest, sourced description of a
  // placeholder situation. The client renders the two differently.
  isPlaceholder: z.boolean(),
  sourceNote: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
}).strict();

export const pageListSchema = z.object({ pages: z.array(contentPageSchema) }).strict();

export const pageRevisionSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  isPlaceholder: z.boolean(),
  author: z.string().min(1),
  recordedAt: z.string().datetime(),
}).strict();

export const pageRevisionsSchema = z.object({
  revisions: z.array(pageRevisionSchema),
}).strict();
