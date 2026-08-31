import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Harness, harness } from './http-harness';

/**
 * TAB 10 — the decision NOT to collect citizen enquiries, asserted.
 *
 * A decision recorded only in a document is a decision someone reverses by
 * accident. These tests fail if intake appears without the record being
 * replaced, which is the whole point: the deliverable of TAB 10 is a ruling,
 * and a ruling needs a gate or it is a wish.
 */

const DECISION = join(__dirname, '../docs/DECISION-2026-08-31-citizen-intake.md');

let api: Harness;

beforeAll(async () => { api = await harness(); }, 180000);
afterAll(async () => { await api.close(); });

const inject = (method: string, url: string, payload?: unknown): Promise<{
  statusCode: number;
}> => (api.app.getHttpAdapter().getInstance() as {
  inject: (o: { method: string; url: string; payload?: unknown }) => Promise<{
    statusCode: number;
  }>;
}).inject({ method, url, ...(payload === undefined ? {} : { payload }) });

describe('the written decision exists', () => {
  it('is in the repository, not only in a conversation', () => {
    // TAB 10's first acceptance criterion: a written decision from the owner
    // exists before any intake code is merged.
    const record = readFileSync(DECISION, 'utf8');

    expect(record).toContain('**Status:** Decided');
    expect(record).toContain('The portal will not accept citizen enquiries');
  });

  it('names what would change it, so the decision is revisitable not permanent', () => {
    const record = readFileSync(DECISION, 'utf8');

    expect(record).toContain('publishes its own privacy policy');
    expect(record).toContain('confirmed contacts');
  });
});

describe('the API accepts nothing from a citizen', () => {
  it('exposes no route that takes a body', async () => {
    // Swept across every path the service actually serves, rather than a
    // hand-listed few — a new write route added later is exactly the change
    // this test exists to catch.
    const paths = [
      '/offices', '/officials', '/permits', '/forms', '/pages', '/search',
      '/announcements', '/municipality/profile', '/contact', '/enquiries', '/messages',
    ];

    for (const path of paths) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await inject(method, path, { name: 'A Citizen', message: 'hello' });
        // 404 (no such route) or 405 (route exists, method does not). Anything
        // that accepted the payload — 200, 201, 202, 400 from validation —
        // means something is now reading citizen-supplied data.
        expect([404, 405]).toContain(response.statusCode);
      }
    }
  });

  it('holds no table for enquiry data', async () => {
    // The schema is the other half. A route can be added tomorrow; a table is
    // where the liability would actually accumulate.
    const tables = await api.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'`);
    const names = tables.rows.map((row) => row.table_name);

    for (const forbidden of ['enquiries', 'messages', 'contact_submissions', 'citizen_contacts']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('holds no column that looks like a citizen’s personal data', async () => {
    // The office and official records name public officials in their public
    // roles, which is not personal data collected FROM anyone. What must not
    // exist is a column holding something a member of the public typed.
    const columns = await api.db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and (column_name like '%sender%' or column_name like '%enquiry%'
               or column_name like '%submitter%' or column_name like '%citizen%')`);

    expect(columns.rows).toEqual([]);
  });
});

describe('the privacy claim the decision rests on stays true', () => {
  it('serves the privacy page still saying no personal data is collected', async () => {
    // If intake is ever built, THIS is the test that should fail first — before
    // the route tests — because the notice has to change before the collection
    // starts, not after.
    const { body } = await api.get('/pages/privacy-policy');
    const page = body as { body: string; isPlaceholder: boolean };

    expect(page.body).toContain('does not currently collect personal data');
    expect(page.isPlaceholder).toBe(true);
  });
});
