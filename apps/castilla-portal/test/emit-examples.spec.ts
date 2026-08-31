import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { exampleResponses } from './examples';

/**
 * Regenerates contract/examples.json.
 *
 * Lives as a test rather than a script because capturing a real response needs
 * the same seeded harness the tests use, and standing that up twice in two
 * different ways is how the "examples" drift from the responses. Run with
 * `npm run examples:emit`; skipped in a normal suite run.
 */
const RUN = process.env['EMIT_EXAMPLES'] === '1';

(RUN ? it : it.skip)('writes the example responses', async () => {
  const { examples, close } = await exampleResponses();
  try {
    const path = join(__dirname, '../contract/examples.json');
    writeFileSync(path, `${JSON.stringify(examples, null, 2)}\n`);
    expect(Object.keys(examples).length).toBeGreaterThan(10);
  } finally {
    await close();
  }
}, 300000);
