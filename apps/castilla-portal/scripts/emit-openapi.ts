import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  municipalityProfileSchema, officeDetailSchema, officeListSchema, officeSummarySchema,
  announcementCountSchema, announcementDetailSchema, announcementListSchema,
  announcementSummarySchema, formListSchema, formRevisionsSchema, officialListSchema,
  officialSchema,
  contentPageSchema, pageListSchema, pageRevisionSchema, pageRevisionsSchema,
  permitCatalogueSchema, permitDetailSchema, permitSummarySchema, profileFieldSchema,
  searchResponseSchema, searchResultSchema, storedFormSchema,
} from '../src/http/contract';

/**
 * Renders contract/openapi.json from the zod schemas in src/http/contract.ts.
 *
 * Generated, never hand-written: a document maintained separately from the code
 * that serves it describes what someone INTENDED, and the gap between the two
 * is invisible until a client trusts the document. `npm run contract:check`
 * fails the gate if this file is stale.
 */
/**
 * OpenAPI 3.1 IS JSON Schema 2020-12, where `exclusiveMinimum` is a NUMBER.
 *
 * zod-to-json-schema's `openApi3` target — and, in this version, its
 * `jsonSchema2020-12` target too — emit the OpenAPI 3.0 form
 * (`exclusiveMinimum: true` beside `minimum: 0`), which is invalid under 3.1
 * and which a 3.1 client generator reads wrongly. `jsonSchema7` produces the
 * numeric form that both drafts accept. Caught by validating the document's own
 * schemas with Ajv rather than by reading it.
 */
const SCHEMA_TARGET = { target: 'jsonSchema7' } as const;

/** `$schema` is a document-level keyword and is not valid inside a component. */
function withoutDialect(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema;
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Castilla LGU Portal — public content API',
    version: '0.2.0',
    description:
      'API for the Municipality of Castilla, Sorsogon.\n\n'
      + 'THREE USER TYPES. **PUBLIC** reads this site with no account and is served every '
      + 'endpoint outside /staff and /session. **CITIZEN** — the single word for what is also '
      + 'called an applicant or a business owner — files permits through the separate eBPCO '
      + 'system and has NO account here; this site collects nothing from them, by a recorded '
      + 'decision. **ADMIN** is LGU staff, with sub-types by access level, and reaches /staff.\n\n'
      + 'Content the LGU has not confirmed is OMITTED rather than returned as null or as a '
      + 'placeholder string: an absent key means the municipality has not verified that fact. '
      + 'A field that is absent when unconfirmed is `optional` in these schemas and never '
      + '`nullable`, because those describe different situations to a generated client.\n\n'
      + 'See contract/CHANGELOG.md for what changed and whether it breaks a client.',
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
    '/staff/workflow/backlog': {
      get: {
        summary: 'What the LGU still has to confirm',
        description:
          'Grouped by entity, not by field: a person confirming an office\'s contact does '
          + 'telephone, email, location and hours in one sitting, and a flat list describes the '
          + 'same backlog as four times the work. Requires `content:read`.',
        security: [{ bearer: [] }],
        responses: { 200: { description: 'The backlog' }, 404: { description: 'No valid session' } },
      },
    },
    '/staff/workflow/proposals': {
      post: {
        summary: 'Propose a change',
        description:
          'A proposal changes NOTHING a citizen can read until it is confirmed — that is what '
          + 'makes the four-eyes rule meaningful rather than merely delaying harm. The proposer '
          + 'is taken from the session and MUST NOT be sent in the body; an undeclared key is '
          + 'refused outright. Requires `content:propose`.',
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProposalRequest' } } } },
        responses: {
          201: { description: 'Proposal recorded' },
          400: { description: 'Malformed, or an undeclared key', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          409: { description: 'A proposal is already open for this field', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/workflow/proposals/{id}/confirm': {
      post: {
        summary: 'Confirm a proposal',
        description:
          'Refused when the confirmer is the proposer, for a contact field or an official\'s '
          + 'name — a change to a real person needs two people. Enforced in authorisation before '
          + 'the handler AND in the domain. Requires `content:confirm`.',
        security: [{ bearer: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Confirmed' },
          403: { description: 'Four-eyes, or the role lacks content:confirm', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          409: { description: 'Already decided, or another confirmation won the race', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No such proposal, or no valid session' },
        },
      },
    },
    '/staff/workflow/revert': {
      post: {
        summary: 'Return a confirmed field to pending',
        description:
          'Keeps the value and its provenance: reverting says "we are no longer standing behind '
          + 'this", not "we never knew it". Requires `content:confirm`.',
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevertRequest' } } } },
        responses: {
          200: { description: 'Reverted' },
          409: { description: 'Not currently confirmed', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/announcements': {
      post: {
        summary: 'Draft an announcement',
        description:
          'Creates it as a DRAFT: nothing is served until it is published. The body is plain '
          + 'text and markup is refused — the HTML a browser receives is rendered server-side at '
          + 'read time. Requires `announcements:publish`.',
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnnouncementDraft' } } } },
        responses: {
          201: { description: 'Drafted' },
          400: { description: 'Malformed, or the body contains markup', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          409: { description: 'That slug is taken', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/announcements/{slug}/publish': {
      post: {
        summary: 'Publish, or schedule',
        description:
          'A `publishAt` in the future is a SCHEDULE — the read queries compare it to the clock, '
          + 'so the notice appears on its own minute with no deploy and no job running. Requires '
          + '`announcements:publish`.',
        security: [{ bearer: [] }],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false,
          properties: {
            publishAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        } } } },
        responses: {
          200: { description: 'Published or scheduled' },
          409: { description: 'Withdrawn, or the expiry precedes publication', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/announcements/{slug}': {
      delete: {
        summary: 'Withdraw an announcement',
        description:
          'Stops being served; never deleted. The database refuses a withdrawal with no event '
          + 'naming who did it. Requires `announcements:publish`.',
        security: [{ bearer: [] }],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false,
          properties: { reason: { type: 'string' } },
        } } } },
        responses: {
          200: { description: 'Withdrawn' },
          409: { description: 'Already withdrawn, or no such announcement', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/pages/{key}': {
      put: {
        summary: 'Replace a narrative page',
        description:
          'Archives the prior text as a revision BEFORE overwriting, and returns the page to '
          + '`pending` because nobody has sourced the new words. Requires `pages:edit`.',
        security: [{ bearer: [] }],
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PageEdit' } } } },
        responses: {
          200: { description: 'Replaced' },
          409: { description: 'No such page', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          404: { description: 'No valid session' },
        },
      },
    },
    '/staff/history/{entityType}/{entityId}': {
      get: {
        summary: 'An entity\'s editorial history',
        description:
          'Who changed what, when, and on what basis — every confirmation, revert, announcement '
          + 'lifecycle change and page revision, oldest first. Append-only at the database level: '
          + 'a mistaken entry is corrected by appending, never by editing. A value belonging to a '
          + 'field that has since been WITHHELD is redacted here at read time and flagged '
          + '`redacted`; the stored row keeps it in full, so the trail can still answer whether '
          + 'something was ever published and when it stopped.',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'entityType', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'entityId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'The history' },
          404: { description: 'No valid session' },
        },
      },
    },
    '/session': {
      post: {
        summary: 'Sign in',
        description:
          'Returns an opaque bearer token, valid 8 hours. Every failure — wrong password, '
          + 'unknown address, disabled account, locked out — returns the SAME 401 with the same '
          + 'body, because any difference between them enumerates the LGU\'s staff. The real '
          + 'reason is written to the sign-in log for the operator.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['email', 'password'], additionalProperties: false,
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        } } } },
        responses: {
          200: { description: 'Signed in', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
          401: { description: 'Not accepted', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
      get: {
        summary: 'Who am I',
        security: [{ bearer: [] }],
        responses: { 200: { description: 'The signed-in account' }, 404: { description: 'No valid session' } },
      },
      delete: {
        summary: 'Sign out',
        description:
          'Deletes the session row. The row IS the session, so replaying the token afterwards '
          + 'cannot work — there is no denylist a later code path could forget to consult.',
        security: [{ bearer: [] }],
        responses: { 204: { description: 'Signed out' } },
      },
    },
    '/pages': {
      get: {
        summary: 'The narrative pages',
        description:
          'History, vision, mission, seal description and privacy policy, keyed by MEANING '
          + 'rather than by id. A PENDING page is served with its placeholder text and a flag, '
          + 'not blanked: the site currently shows an honest "pending publication by LGU '
          + 'Castilla" notice, and silence would be a downgrade. `state` and `isPlaceholder` are '
          + 'separate — a page can be an honest, sourced description of a placeholder situation.',
        responses: {
          200: { description: 'All five pages', content: { 'application/json': { schema: { $ref: '#/components/schemas/PageList' } } } },
        },
      },
    },
    '/pages/{key}': {
      get: {
        summary: 'One narrative page',
        parameters: [{ name: 'key', in: 'path', required: true,
          schema: { type: 'string', enum: ['history', 'vision', 'mission', 'seal-description', 'privacy-policy'] } }],
        responses: {
          200: { description: 'The page', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContentPage' } } } },
          404: { description: 'No such page', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/pages/{key}/revisions': {
      get: {
        summary: 'What this page said before',
        description:
          'Newest first, each with an author and a timestamp. The privacy policy in particular '
          + 'will be replaced by an LGU-authored document, and the placeholder must remain '
          + 'retrievable: what the site said at a given time is a fact about the site.',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Prior revisions', content: { 'application/json': { schema: { $ref: '#/components/schemas/PageRevisions' } } } },
          404: { description: 'No such page', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/search': {
      get: {
        summary: 'Search offices and permits',
        description:
          'PostgreSQL full-text search, not a substring match. An office is found by its own '
          + 'fields AND by the names of the permits it issues — which is why \'zoning\' returns '
          + 'the Planning Office, an office that contains the word in none of its own fields. '
          + 'Content the read API withholds is never indexed: search is not a side channel '
          + 'around the publication gate. `q` accepts the syntax a search box implies — quoted '
          + 'phrases, `or`, a leading minus.',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['office', 'permit'] } },
          { name: 'facet', in: 'query', required: false, schema: { type: 'string' },
            description: 'An office category or a permit office-group. Composes with `q`.' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
        responses: {
          200: { description: 'Matches, most relevant first', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
          400: { description: 'No query, or an unknown type', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
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
    securitySchemes: {
      bearer: {
        type: 'http', scheme: 'bearer',
        description:
          'An opaque session token from POST /session. Staff routes live under /staff and are '
          + 'invisible to an unauthenticated caller: they answer 404, not 401, so probing for '
          + 'which staff endpoints exist reveals nothing.',
      },
    },
    schemas: {
      OfficeSummary: withoutDialect(zodToJsonSchema(officeSummarySchema, SCHEMA_TARGET)),
      OfficeList: withoutDialect(zodToJsonSchema(officeListSchema, SCHEMA_TARGET)),
      OfficeDetail: withoutDialect(zodToJsonSchema(officeDetailSchema, SCHEMA_TARGET)),
      Official: withoutDialect(zodToJsonSchema(officialSchema, SCHEMA_TARGET)),
      ProposalRequest: {
        type: 'object', additionalProperties: false,
        required: ['entityType', 'entityId', 'fieldName', 'proposedValue',
                   'sourceDescription', 'sourcedOn', 'method'],
        properties: {
          entityType: { type: 'string' }, entityId: { type: 'string' },
          fieldName: { type: 'string' }, proposedValue: { type: 'string' },
          sourceDescription: { type: 'string', minLength: 8,
            description: "A source someone else could check. 'LGU' is not a source." },
          sourcedOn: { type: 'string', format: 'date' },
          method: { type: 'string', enum: ['direct-read', 'search-extraction', 'official-document'] },
        },
      },
      RevertRequest: {
        type: 'object', additionalProperties: false,
        required: ['entityType', 'entityId', 'fieldName'],
        properties: {
          entityType: { type: 'string' }, entityId: { type: 'string' },
          fieldName: { type: 'string' },
        },
      },
      AnnouncementDraft: {
        type: 'object', additionalProperties: false,
        required: ['slug', 'title', 'body', 'category'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
          title: { type: 'string' },
          body: { type: 'string', description: 'Plain text. Markup is refused.' },
          category: { type: 'string' },
          attachmentFormId: { type: 'string', format: 'uuid' },
        },
      },
      PageEdit: {
        type: 'object', additionalProperties: false,
        required: ['title', 'body', 'isPlaceholder'],
        properties: {
          title: { type: 'string' }, body: { type: 'string' },
          isPlaceholder: { type: 'boolean' },
        },
      },
      Session: {
        type: 'object',
        required: ['token', 'account'],
        additionalProperties: false,
        properties: {
          token: { type: 'string', description: 'Opaque bearer token. Shown once; only its sha256 is stored.' },
          account: {
            type: 'object',
            required: ['email', 'displayName', 'role', 'scopes'],
            additionalProperties: false,
            properties: {
              email: { type: 'string' }, displayName: { type: 'string' },
              role: { type: 'string', enum: ['viewer', 'content-editor', 'content-approver', 'announcements-publisher', 'administrator'] },
              scopes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      ContentPage: withoutDialect(zodToJsonSchema(contentPageSchema, SCHEMA_TARGET)),
      PageList: withoutDialect(zodToJsonSchema(pageListSchema, SCHEMA_TARGET)),
      PageRevision: withoutDialect(zodToJsonSchema(pageRevisionSchema, SCHEMA_TARGET)),
      PageRevisions: withoutDialect(zodToJsonSchema(pageRevisionsSchema, SCHEMA_TARGET)),
      SearchResult: withoutDialect(zodToJsonSchema(searchResultSchema, SCHEMA_TARGET)),
      SearchResponse: withoutDialect(zodToJsonSchema(searchResponseSchema, SCHEMA_TARGET)),
      AnnouncementSummary: withoutDialect(zodToJsonSchema(announcementSummarySchema, SCHEMA_TARGET)),
      AnnouncementDetail: withoutDialect(zodToJsonSchema(announcementDetailSchema, SCHEMA_TARGET)),
      AnnouncementList: withoutDialect(zodToJsonSchema(announcementListSchema, SCHEMA_TARGET)),
      AnnouncementCount: withoutDialect(zodToJsonSchema(announcementCountSchema, SCHEMA_TARGET)),
      StoredForm: withoutDialect(zodToJsonSchema(storedFormSchema, SCHEMA_TARGET)),
      FormList: withoutDialect(zodToJsonSchema(formListSchema, SCHEMA_TARGET)),
      FormRevisions: withoutDialect(zodToJsonSchema(formRevisionsSchema, SCHEMA_TARGET)),
      PermitSummary: withoutDialect(zodToJsonSchema(permitSummarySchema, SCHEMA_TARGET)),
      PermitCatalogue: withoutDialect(zodToJsonSchema(permitCatalogueSchema, SCHEMA_TARGET)),
      PermitDetail: withoutDialect(zodToJsonSchema(permitDetailSchema, SCHEMA_TARGET)),
      OfficialList: withoutDialect(zodToJsonSchema(officialListSchema, SCHEMA_TARGET)),
      ProfileField: withoutDialect(zodToJsonSchema(profileFieldSchema, SCHEMA_TARGET)),
      MunicipalityProfile: withoutDialect(zodToJsonSchema(municipalityProfileSchema, SCHEMA_TARGET)),
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
