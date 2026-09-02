import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The citizen contract fragment says what the recorded responses actually hold.
 *
 * Written for the citizen web portal lane, which is building an HTTP client
 * from scratch and asked not to infer shapes from prose. A hand-written
 * contract agrees with the server because the same person wrote both; this
 * checks it against `contract/response-samples.json`, which is real bytes from
 * the real controllers over real PostgreSQL.
 *
 * Checked BOTH WAYS, which is the half that matters. A field documented and not
 * returned is a client waiting for something that never comes; a field returned
 * and not documented is a client that never learns it exists -- and the second
 * is the one a "does the sample validate?" check misses entirely.
 *
 * Deliberately not a YAML/JSON-Schema validator. There is no YAML parser in this
 * service's dependencies, and reaching for one that arrives transitively through
 * a linter is a gate that disappears on an unrelated upgrade. The property worth
 * holding is field parity, and that is readable from the document directly.
 */

const FRAGMENT = readFileSync(
  join(__dirname, '../../contract/citizen-endpoints.openapi.yaml'), 'utf8');
const SAMPLES = JSON.parse(
  readFileSync(join(__dirname, '../../contract/response-samples.json'), 'utf8'),
) as { samples: Record<string, { status: number; body: unknown }> };

/**
 * The property names a schema block declares as `required: [...]`.
 *
 * Read from the `required` list rather than the `properties` block: `required`
 * is what a client may rely on being present, which is exactly the promise
 * being checked. Handles both the inline `[a, b]` form and the dashed list.
 */
function requiredOf(schemaName: string): string[] {
  const start = FRAGMENT.indexOf(`    ${schemaName}:`);
  if (start < 0) throw new Error(`no schema named ${schemaName} in the fragment`);
  const after = FRAGMENT.slice(start);
  const marker = after.indexOf('required:');
  if (marker < 0) throw new Error(`${schemaName} declares no required list`);
  // Everything between the first '[' and the matching ']' after `required:`.
  const open = after.indexOf('[', marker);
  const close = after.indexOf(']', open);
  return after.slice(open + 1, close)
    .split(',').map((name) => name.trim()).filter((name) => name.length > 0);
}

const bodyOf = (sample: string): Record<string, unknown> => {
  const found = SAMPLES.samples[sample];
  if (found === undefined) throw new Error(`no recorded sample named ${sample}`);
  return found.body as Record<string, unknown>;
};

describe('the citizen contract fragment matches the recorded responses', () => {
  it.each([
    ['Permit', 'applicant.applications.permit'],
    ['ResubmitResult', 'applicant.applications.resubmitDocument'],
    ['ApplicationRequirements', 'applicant.applications.requirements'],
  ])('%s declares exactly the keys %s returns', (schema, sample) => {
    expect([...requiredOf(schema)].sort()).toEqual(Object.keys(bodyOf(sample)).sort());
  });

  it('ApplicationDocument declares exactly the keys a document returns', () => {
    const documents = SAMPLES.samples['applicant.applications.documents']!.body as
      Record<string, unknown>[];

    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect([...requiredOf('ApplicationDocument')].sort()).toEqual(Object.keys(document).sort());
    }
  });

  it('records BOTH branches of `release`, because the fragment promises the key is always present', () => {
    // The citizen lane asked specifically whether `release` is null or absent.
    // Answering in prose would be the guess they asked not to be given, so both
    // branches are recorded bytes.
    const ready = bodyOf('applicant.applications.permit');
    const notReady = bodyOf('applicant.applications.permit.beforeRelease');

    expect(ready).toHaveProperty('release');
    expect(notReady).toHaveProperty('release', null);
    expect(ready['release']).not.toBeNull();
  });

  it('documents the reason object with every key it actually carries', () => {
    const documents = SAMPLES.samples['applicant.applications.documents']!.body as
      Record<string, unknown>[];
    const reviewed = documents.find((document) => document['reviewReason'] !== null);

    // If this is undefined the sample stopped exercising a reviewed document,
    // and the reason object below would be checked against nothing.
    expect(reviewed).toBeDefined();
    expect(Object.keys(reviewed!['reviewReason'] as object).sort())
      .toEqual(['code', 'description', 'label']);
  });

  it('records the honest case: attribution incomplete, so not-provided is not certain', () => {
    // The recorded sample deliberately leaves one document unattributed --
    // which is the state EVERY application filed before migration 035 is in.
    // A sample showing only the tidy case would let a client ship a "missing
    // documents" list it has no right to present as certain.
    const body = bodyOf('applicant.applications.requirements');

    expect(body['attributionComplete']).toBe(false);
    expect(body['unattributedDocuments']).toBeGreaterThan(0);
    const entries = body['requirements'] as Record<string, unknown>[];
    expect(entries.some((entry) => entry['status'] === 'provided')).toBe(true);
    expect(entries.some((entry) => entry['status'] === 'not-provided')).toBe(true);
  });

  it('keeps byteSize a string, because a bigint does not survive a JSON number', () => {
    const [first] = SAMPLES.samples['applicant.applications.documents']!.body as
      Record<string, unknown>[];

    expect(typeof first!['byteSize']).toBe('string');
    expect(FRAGMENT).toContain('A STRING, not a number');
  });
});
