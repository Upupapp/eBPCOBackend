import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  municipalityProfileSchema, officeDetailSchema, officeListSchema, officeSummarySchema,
  announcementCountSchema, announcementDetailSchema, announcementListSchema,
  announcementSummarySchema, formListSchema, formRevisionsSchema, officialListSchema,
  officialSchema,
  permitCatalogueSchema, permitDetailSchema, permitSummarySchema, profileFieldSchema,
  storedFormSchema,
} from '../src/http/contract';

/**
 * Renders contract/openapi.json from the zod schemas in src/http/contract.ts.
 *
 * Generated, never hand-written: a document maintained separately from the code
 * that serves it describes what someone INTENDED, and the gap between the two
 * is invisible until a client trusts the document. `npm run contract:check`
 * fails the gate if this file is stale.
 */
const document = {
  openapi: '3.1.0',
  info: {
    title: 'Castilla LGU Portal — public content API',
    version: '0.1.0',
    description:
      'Public read API for the Municipality of Castilla, Sorsogon. Content the LGU has not '
      + 'confirmed is OMITTED from responses rather than returned as null or as a placeholder '
      + 'string: an absent key means the municipality has not verified that fact.',
  },
  servers: [{ url: 'https://castilla-ebpco.online/api' }],
  paths: {
    '/offices': {
      get: {
        summary: 'List municipal offices',
        description:
          'Returned in the municipality\'s own order, which groups executive offices first. '
          + 'Not alphabetical.',
        parameters: [{
          name: 'category', in: 'query', required: false,
          schema: { type: 'string' },
          description: 'Restrict to one office category. An unknown category is a 400, not an '
            + 'empty list, so a typo is distinguishable from a category with no offices.',
        }],
        responses: {
          200: { description: 'The published offices', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfficeList' } } } },
          400: { description: 'Unknown category', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/officials': {
      get: {
        summary: 'Elected leadership',
        description:
          'The Mayor, Vice Mayor, Sangguniang Bayan members and ex-officio seats the '
          + 'municipality has confirmed. A seat whose holder is not confirmed is OMITTED — the '
          + 'ABC President is currently withheld for that reason.',
        responses: {
          200: { description: 'The confirmed officials', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfficialList' } } } },
        },
      },
    },
    '/municipality/profile': {
      get: {
        summary: 'Municipality profile',
        description:
          'Ordered profile fields. A field that is a genuine MAGNITUDE also carries `count`, '
          + 'and optionally `countSuffix` and `countDecimals`; formatting the count to that '
          + 'precision and appending the suffix reproduces `value` exactly, so a client may '
          + 'animate the number or print the string and get the same result. Identifiers — ZIP '
          + 'and PSGC codes — carry no count, because counting up to a postal code is meaningless.',
        responses: {
          200: { description: 'The confirmed profile fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/MunicipalityProfile' } } } },
        },
      },
    },
    '/permits': {
      get: {
        summary: 'The permit catalogue',
        description:
          'All 19 permits, grouped by issuing-office group. Each carries its own '
          + '`confirmationState`: unlike offices and officials, an unconfirmed permit is SERVED '
          + 'with its state attached rather than withheld — all 19 are currently `pending`, and '
          + 'withholding them would publish an empty catalogue and tell a citizen the '
          + 'municipality issues no permits. Grouping reorders relative to the flat catalogue '
          + '(Zoning sits between engineering permits), but order WITHIN each group is canonical.',
        responses: {
          200: { description: 'The catalogue', content: { 'application/json': { schema: { $ref: '#/components/schemas/PermitCatalogue' } } } },
        },
      },
    },
    '/permits/{slug}': {
      get: {
        summary: 'One permit in full',
        description:
          'Requirements in published order, validity, an optional process note, and the '
          + 'application form and checklist where the LGU bundles them — 5 of the 19 publish no '
          + 'form, and those omit the key rather than sending a broken link. `issuingOffice.slug` '
          + 'is absent for the two BFP permits: the Bureau of Fire Protection is a national '
          + 'agency with no municipal office page.',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The permit', content: { 'application/json': { schema: { $ref: '#/components/schemas/PermitDetail' } } } },
          404: { description: 'No permit is published with that slug', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/announcements': {
      get: {
        summary: 'Published announcements',
        description:
          'Published and currently live, newest first. A scheduled announcement is absent until '
          + 'its moment passes — no deploy and no job is involved, because the publication time '
          + 'is compared to the clock at read time. Drafts and withdrawn announcements are never '
          + 'served.',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 50, default: 20 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          200: { description: 'Live announcements', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnnouncementList' } } } },
          400: { description: 'Invalid paging', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/announcements/count': {
      get: {
        summary: 'How many announcements are live',
        description:
          'What the header badge needs and nothing else: one integer, from one query against a '
          + 'partial index. Cacheable for 60 seconds and `public`, because the answer is the same '
          + 'for every reader — there is deliberately no per-user unread state.',
        responses: {
          200: { description: 'The count', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnnouncementCount' } } } },
        },
      },
    },
    '/announcements/{slug}': {
      get: {
        summary: 'One announcement',
        description:
          'Includes EXPIRED announcements, flagged `expired`, so a link shared on social media '
          + 'does not rot the day the notice lapses. Drafts, scheduled and withdrawn '
          + 'announcements all 404 alike — that a draft exists is itself information.',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The announcement', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnnouncementDetail' } } } },
          404: { description: 'Not published', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/forms': {
      get: {
        summary: 'The bundled application forms',
        description:
          'Current revisions only — what a citizen should be filing today. Each carries a '
          + 'sha256 checksum of the bytes exactly as the LGU issued them; these documents are '
          + 'never re-generated, flattened or re-exported.',
        responses: {
          200: { description: 'Current forms', content: { 'application/json': { schema: { $ref: '#/components/schemas/FormList' } } } },
        },
      },
    },
    '/forms/{familySlug}/revisions': {
      get: {
        summary: 'Every revision of one form',
        description:
          'Newest first. A superseded revision stays retrievable because an application filed '
          + 'on last year\'s form is still a real application.',
        parameters: [{ name: 'familySlug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'All revisions', content: { 'application/json': { schema: { $ref: '#/components/schemas/FormRevisions' } } } },
          404: { description: 'No such form', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/forms/{familySlug}/download': {
      get: {
        summary: 'Download a form',
        description:
          'The stored bytes, unmodified, with the original filename in Content-Disposition. '
          + 'Public and unauthenticated by design: these are blank forms and gating them '
          + 'defeats the portal. Omit `checksum` for the current revision; pass one to pin an '
          + 'exact revision. A missing form is a JSON 404 — never an HTML page, and never a 200, '
          + 'because a browser that saves an error page as .pdf sends a citizen to the counter '
          + 'with it.',
        parameters: [
          { name: 'familySlug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'checksum', in: 'query', required: false, schema: { type: 'string' },
            description: 'Pin an exact revision by its sha256.' },
        ],
        responses: {
          200: {
            description: 'The form',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
          },
          404: { description: 'No such form', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/offices/{slug}': {
      get: {
        summary: 'One office in full',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The office', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfficeDetail' } } } },
          404: { description: 'No office is published with that slug', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      OfficeSummary: zodToJsonSchema(officeSummarySchema, { target: 'openApi3' }),
      OfficeList: zodToJsonSchema(officeListSchema, { target: 'openApi3' }),
      OfficeDetail: zodToJsonSchema(officeDetailSchema, { target: 'openApi3' }),
      Official: zodToJsonSchema(officialSchema, { target: 'openApi3' }),
      AnnouncementSummary: zodToJsonSchema(announcementSummarySchema, { target: 'openApi3' }),
      AnnouncementDetail: zodToJsonSchema(announcementDetailSchema, { target: 'openApi3' }),
      AnnouncementList: zodToJsonSchema(announcementListSchema, { target: 'openApi3' }),
      AnnouncementCount: zodToJsonSchema(announcementCountSchema, { target: 'openApi3' }),
      StoredForm: zodToJsonSchema(storedFormSchema, { target: 'openApi3' }),
      FormList: zodToJsonSchema(formListSchema, { target: 'openApi3' }),
      FormRevisions: zodToJsonSchema(formRevisionsSchema, { target: 'openApi3' }),
      PermitSummary: zodToJsonSchema(permitSummarySchema, { target: 'openApi3' }),
      PermitCatalogue: zodToJsonSchema(permitCatalogueSchema, { target: 'openApi3' }),
      PermitDetail: zodToJsonSchema(permitDetailSchema, { target: 'openApi3' }),
      OfficialList: zodToJsonSchema(officialListSchema, { target: 'openApi3' }),
      ProfileField: zodToJsonSchema(profileFieldSchema, { target: 'openApi3' }),
      MunicipalityProfile: zodToJsonSchema(municipalityProfileSchema, { target: 'openApi3' }),
      Problem: {
        type: 'object',
        description: 'RFC 9457 Problem Details.',
        properties: {
          type: { type: 'string' }, title: { type: 'string' },
          status: { type: 'integer' }, detail: { type: 'string' },
        },
        required: ['type', 'title', 'status', 'detail'],
      },
    },
  },
};

const path = join(__dirname, '../contract/openapi.json');
const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(path, 'utf8');
  if (existing !== rendered) {
    console.error('contract/openapi.json is stale. Run `npm run contract:emit`.');
    process.exit(1);
  }
  console.log('ok   contract/openapi.json matches the schemas');
} else {
  writeFileSync(path, rendered);
  console.log(`wrote ${path}`);
}
