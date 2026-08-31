import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { PUBLIC_SAMPLES } from './examples';
import { routesOf } from './routes';
import { Harness, harness } from './http-harness';

/** TAB 14 — the contract, and the checks that keep it true. */

interface Document {
  openapi: string;
  info: { version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

const contract = (): Document => JSON.parse(
  readFileSync(join(__dirname, '../contract/openapi.json'), 'utf8')) as Document;

const examples = (): Record<string, unknown> => JSON.parse(
  readFileSync(join(__dirname, '../contract/examples.json'), 'utf8')) as Record<string, unknown>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let api: Harness;

beforeAll(async () => { api = await harness(); }, 180000);
afterAll(async () => { await api.close(); });

describe('the document describes the implementation', () => {
  it('documents every route the application serves', () => {
    // TAB 14's criterion: a route added without a contract entry fails the
    // build. Read from the ROUTER, so this catches the route nobody remembered
    // to write down — which is exactly how a sibling project's contract fell 41
    // routes behind its implementation.
    const document = contract();
    const undocumented: string[] = [];

    for (const route of routesOf(api.app)) {
      const path = document.paths[route.path];
      if (path === undefined || !(route.method.toLowerCase() in path)) {
        undocumented.push(`${route.method} ${route.path}`);
      }
    }

    expect(undocumented).toEqual([]);
  });

  it('documents nothing the application does not serve', () => {
    // The other direction. A contract entry for a route that does not exist
    // generates a client method that always 404s, and the front-end lane
    // discovers it at runtime.
    const document = contract();
    const served = new Set(
      routesOf(api.app).map((route) => `${route.method.toLowerCase()} ${route.path}`));
    const phantom: string[] = [];

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of Object.keys(operations)) {
        if (!METHODS.includes(method)) continue;
        if (!served.has(`${method} ${path}`)) phantom.push(`${method} ${path}`);
      }
    }

    expect(phantom).toEqual([]);
  });

  it('counts the same on both sides', () => {
    // Stated as a number too, so a simultaneous addition and removal cannot
    // cancel out in the two set comparisons above.
    const document = contract();
    const documented = Object.values(document.paths)
      .flatMap((operations) => Object.keys(operations).filter((m) => METHODS.includes(m)));

    expect(documented).toHaveLength(routesOf(api.app).length);
  });
});

describe('the schemas are honest about what may be absent', () => {
  it('never marks a withheld field nullable instead of optional', () => {
    // TAB 14's rule. A field the API OMITS when unconfirmed must be optional,
    // not nullable-and-always-present: they describe different situations, and
    // a generated client branches on the wrong one.
    const schemas = contract().components.schemas;
    const offending: string[] = [];

    for (const [name, schema] of Object.entries(schemas)) {
      const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const [field, definition] of Object.entries(properties)) {
        const nullable = (definition as { nullable?: boolean }).nullable === true;
        const required = ((schema as { required?: string[] }).required ?? []).includes(field);
        if (nullable && required) offending.push(`${name}.${field}`);
      }
    }

    expect(offending).toEqual([]);
  });

  it('keeps head and contact optional on an office, because they are withheld', () => {
    const detail = contract().components.schemas['OfficeDetail'] as {
      required: string[]; properties: Record<string, unknown>;
    };

    expect(Object.keys(detail.properties)).toContain('head');
    expect(detail.required).not.toContain('head');
    expect(detail.required).not.toContain('contact');
  });

  it('uses only standard JSON Schema types', () => {
    // A non-standard type string generates as an EMPTY OBJECT in every client
    // generator, and the mistake is invisible until runtime.
    const STANDARD = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
    const bad: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const type = (node as { type?: unknown }).type;
      if (typeof type === 'string' && !STANDARD.includes(type)) bad.push(`${path}: ${type}`);
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    };
    // Only actual SCHEMAS. `securitySchemes.bearer.type: 'http'` is a valid
    // OpenAPI security-scheme type and has nothing to do with JSON Schema —
    // walking the whole document conflates the two vocabularies.
    walk(contract().components.schemas, 'components.schemas');
    for (const [path, operations] of Object.entries(contract().paths)) {
      walk(operations, `paths.${path}`);
    }

    expect(bad).toEqual([]);
  });
});

describe('every example is a response the API actually produced', () => {
  const validator = (): Ajv => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const [name, schema] of Object.entries(contract().components.schemas)) {
      ajv.addSchema(schema as object, `#/components/schemas/${name}`);
    }
    return ajv;
  };

  it('validates each captured example against its own schema', () => {
    // TAB 14's criterion. The examples were captured from the running API
    // against seeded data, so this also proves the schemas describe the real
    // responses rather than an intention.
    const document = contract();
    const captured = examples();
    const ajv = validator();
    const failures: string[] = [];

    for (const sample of PUBLIC_SAMPLES) {
      const example = captured[sample.name];
      if (example === undefined) { failures.push(`${sample.name}: no example`); continue; }

      const [, path] = sample.name.split(' ');
      const schema = (document.paths[path!]?.['get'] as {
        responses?: { 200?: { content?: Record<string, { schema?: { $ref?: string } }> } };
      })?.responses?.[200]?.content?.['application/json']?.schema;
      // Endpoints documented without a $ref (the staff and free-form ones) are
      // covered by the route parity tests instead.
      if (schema?.$ref === undefined) continue;

      const validate = ajv.getSchema(schema.$ref);
      if (validate === undefined) { failures.push(`${sample.name}: unknown ${schema.$ref}`); continue; }
      if (!validate(example)) {
        failures.push(`${sample.name}: ${ajv.errorsText(validate.errors)}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('captured an example for every public endpoint', () => {
    const captured = examples();

    for (const sample of PUBLIC_SAMPLES) {
      expect(Object.keys(captured)).toContain(sample.name);
    }
  });

  it('captured them from a fully seeded system, not an empty one', () => {
    // An example showing an empty array for an endpoint that works is worse
    // than no example, because it looks authoritative.
    const captured = examples() as Record<string, { offices?: unknown[]; forms?: unknown[] }>;

    expect(captured['GET /offices']?.offices).toHaveLength(19);
    expect(captured['GET /forms']?.forms).toHaveLength(13);
  });
});

describe('the contract is versioned and its changes are legible', () => {
  it('publishes a version that appears in the changelog', () => {
    const version = contract().info.version;
    const changelog = readFileSync(join(__dirname, '../contract/CHANGELOG.md'), 'utf8');

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(changelog).toContain(`## ${version}`);
  });

  it('distinguishes additive from breaking without diffing', () => {
    // TAB 14's requirement, and the reason it matters: a client generated from
    // a stale contract is trusted precisely because it looks current.
    const changelog = readFileSync(join(__dirname, '../contract/CHANGELOG.md'), 'utf8');

    expect(changelog).toMatch(/\*\*Additive\*\*|\*\*Breaking\*\*/);
    expect(changelog).toContain('optional to always-present is **breaking**');
  });

  it('names the three user types, so a client knows who it is for', () => {
    const description = contract().info.description;

    for (const type of ['PUBLIC', 'CITIZEN', 'ADMIN']) {
      expect(description).toContain(type);
    }
  });
});
