import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FormImporter } from '../src/forms/form-importer';
import { SearchIndexer } from '../src/search/search-indexer';
import { Harness, harness } from './http-harness';

const BUNDLE = '/Users/user/eBPCO-Website/castilla-lgu-portal/public/assets/permits';

/** The public endpoints a generated client will call, with a real sample URL. */
export const PUBLIC_SAMPLES: { name: string; url: string }[] = [
  { name: 'GET /offices', url: '/offices' },
  { name: 'GET /offices/{slug}', url: '/offices/municipal-engineering' },
  { name: 'GET /officials', url: '/officials' },
  { name: 'GET /municipality/profile', url: '/municipality/profile' },
  { name: 'GET /permits', url: '/permits' },
  { name: 'GET /permits/{slug}', url: '/permits/demolition-permit' },
  { name: 'GET /pages', url: '/pages' },
  { name: 'GET /pages/{key}', url: '/pages/vision' },
  { name: 'GET /pages/{key}/revisions', url: '/pages/vision/revisions' },
  { name: 'GET /forms', url: '/forms' },
  { name: 'GET /forms/{familySlug}/revisions', url: '/forms/sanitary-permit-form/revisions' },
  { name: 'GET /search', url: '/search?q=zoning' },
  { name: 'GET /announcements', url: '/announcements' },
  { name: 'GET /announcements/count', url: '/announcements/count' },
];

export async function exampleResponses(): Promise<{
  examples: Record<string, unknown>;
  close: () => Promise<void>;
  api: Harness;
}> {
  const api = await harness();
  // A FULLY seeded system. Examples captured from a half-populated one would
  // show a front-end lane empty arrays and 404s for endpoints that work — which
  // is worse than no examples, because it looks authoritative.
  await new FormImporter(api.db).run(
    readdirSync(BUNDLE).filter((name) => name.endsWith('.pdf'))
      .map((filename) => ({ filename, bytes: readFileSync(join(BUNDLE, filename)) })));
  await new SearchIndexer(api.db).rebuild();

  const examples: Record<string, unknown> = {};

  for (const sample of PUBLIC_SAMPLES) {
    const { status, body } = await api.get(sample.url);
    if (status !== 200) throw new Error(`${sample.url} answered ${String(status)}`);
    examples[sample.name] = body;
  }

  return { examples, close: () => api.close(), api };
}
