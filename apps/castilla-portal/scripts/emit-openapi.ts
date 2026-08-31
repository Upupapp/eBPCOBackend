import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  municipalityProfileSchema, officeDetailSchema, officeListSchema, officeSummarySchema,
  officialListSchema, officialSchema, permitCatalogueSchema, permitDetailSchema,
  permitSummarySchema, profileFieldSchema,
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
