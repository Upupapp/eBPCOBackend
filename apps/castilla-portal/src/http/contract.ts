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
}).strict();

export type OfficeListResponse = z.infer<typeof officeListSchema>;
export type OfficeDetailResponse = z.infer<typeof officeDetailSchema>;
