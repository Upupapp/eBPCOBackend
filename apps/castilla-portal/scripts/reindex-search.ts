import { Pool } from 'pg';

import { SearchIndexer } from '../src/search/search-indexer';

/**
 * Rebuilds the search index from the published content.
 *
 * A full rebuild rather than incremental updates: the whole corpus is 19
 * offices and 19 permits, a rebuild costs milliseconds, and an incremental
 * index is a second source of truth that drifts silently — which is how a
 * withheld contact ends up searchable long after it was withdrawn.
 *
 * Run it after seeding, and after any content change.
 */
async function main(): Promise<number> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    console.error('DATABASE_URL is not set');
    return 1;
  }

  const pool = new Pool({ connectionString });
  try {
    const { offices, permits } = await new SearchIndexer(pool).rebuild();
    console.log(`indexed ${offices} offices and ${permits} permits`);
    return 0;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
