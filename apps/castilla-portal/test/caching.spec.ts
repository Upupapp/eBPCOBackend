import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ContentVersions } from '../src/http/cache';
import { ConfirmationService } from '../src/workflow/confirmation.service';
import { Harness, harness } from './http-harness';

/** TAB 13 — caching, invalidation, and the measured budgets. */

let api: Harness;
let versions: ContentVersions;

interface Res { statusCode: number; headers: Record<string, string>; body: string }

const call = (url: string, headers: Record<string, string> = {}): Promise<Res> =>
  (api.app.getHttpAdapter().getInstance() as {
    inject: (o: { method: string; url: string; headers: Record<string, string> }) => Promise<Res>;
  }).inject({ method: 'GET', url, headers });

beforeAll(async () => {
  api = await harness();
  versions = api.app.get(ContentVersions);
}, 180000);

afterAll(async () => { await api.close(); });

describe('every public GET carries a strong ETag and a stated policy', () => {
  const PUBLIC = [
    '/offices', '/offices/municipal-engineering', '/officials', '/municipality/profile',
    '/permits', '/permits/demolition-permit', '/pages', '/pages/mission', '/forms',
    '/search?q=zoning', '/announcements',
  ];

  it.each(PUBLIC)('%s', async (url) => {
    const response = await call(url);

    expect(response.statusCode).toBe(200);
    // Strong, not weak: no W/ prefix. A weak tag would forbid range requests
    // and tells a cache the bytes may differ, which here they do not.
    expect(response.headers['etag']).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(response.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(response.headers['cache-control']).toMatch(/stale-while-revalidate=\d+/);
  });

  it('gives announcements a far shorter window than offices', async () => {
    // TAB 13's guard, as a number rather than an intention.
    const offices = (await call('/offices')).headers['cache-control']!;
    const announcements = (await call('/announcements')).headers['cache-control']!;

    const maxAge = (header: string) => Number(/max-age=(\d+)/.exec(header)![1]);

    expect(maxAge(announcements)).toBeLessThan(maxAge(offices));
    expect(maxAge(announcements)).toBeLessThanOrEqual(60);
  });
});

describe('a repeat request revalidates without touching the database', () => {
  it('returns 304 and runs no query at all', async () => {
    // TAB 13's criterion, and the reason the ETag comes from a version counter
    // rather than a hash of the body: hashing the body means producing it,
    // which means the query, which means 304 saves only bandwidth.
    const first = await call('/offices/municipal-engineering');
    const etag = first.headers['etag']!;

    let queries = 0;
    const original = api.db.query.bind(api.db);
    (api.db as unknown as { query: unknown }).query = (...args: unknown[]) => {
      queries += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };

    const second = await call('/offices/municipal-engineering', { 'if-none-match': etag });

    (api.db as unknown as { query: unknown }).query = original;
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(queries).toBe(0);
  });

  it('returns 200 when the tag does not match', async () => {
    const response = await call('/offices', { 'if-none-match': '"not-the-current-tag"' });

    expect(response.statusCode).toBe(200);
  });

  it('honours a list of tags, and the wildcard', async () => {
    const etag = (await call('/permits')).headers['etag']!;

    expect((await call('/permits',
      { 'if-none-match': `"other", ${etag}` })).statusCode).toBe(304);
    expect((await call('/permits', { 'if-none-match': '*' })).statusCode).toBe(304);
  });
});

describe('invalidation happens at the three moments content changes', () => {
  const workflow = () => new ConfirmationService(api.db, () => new Date(), versions);

  const officeId = async (slug: string): Promise<string> =>
    (await api.db.query<{ id: string }>(
      'select id from offices where slug = $1', [slug])).rows[0]!.id;

  const confirm = async (slug: string, field: string, value: string): Promise<void> => {
    const proposed = await workflow().propose({
      entityType: 'office', entityId: await officeId(slug), fieldName: field,
      proposedValue: value,
      sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
      sourcedOn: '2026-08-31', method: 'official-document', proposedBy: 'ana@castilla.gov.ph',
    });
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.reason}`);
    const done = await workflow().confirm(proposed.value, 'ben@castilla.gov.ph');
    if (!done.ok) throw new Error(`confirm failed: ${done.reason}`);
  };

  it('expires the confirmed office, and no other office', async () => {
    // TAB 13's criterion, stated exactly.
    const target = (await call('/offices/municipal-treasurer')).headers['etag']!;
    const bystander = (await call('/offices/municipal-assessor')).headers['etag']!;

    await confirm('municipal-treasurer', 'contact.telephone', '(056) 555-0101');

    expect((await call('/offices/municipal-treasurer')).headers['etag']).not.toBe(target);
    expect((await call('/offices/municipal-assessor')).headers['etag']).toBe(bystander);
  });

  it('does NOT expire anything when a proposal is merely made', async () => {
    // A proposal changes nothing a citizen can read. Expiring on one would make
    // the cache noisy enough that nobody trusts it.
    const before = (await call('/offices/municipal-budget')).headers['etag']!;
    const list = (await call('/offices')).headers['etag']!;

    const proposed = await workflow().propose({
      entityType: 'office', entityId: await officeId('municipal-budget'),
      fieldName: 'contact.email', proposedValue: 'budget@castilla.gov.ph',
      sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
      sourcedOn: '2026-08-31', method: 'official-document', proposedBy: 'ana@castilla.gov.ph',
    });
    expect(proposed.ok).toBe(true);

    expect((await call('/offices/municipal-budget')).headers['etag']).toBe(before);
    expect((await call('/offices')).headers['etag']).toBe(list);
  });

  it('expires the office again when a field is reverted', async () => {
    // Reverting removes a fact from public view — arguably the moment where a
    // stale cache does the most harm.
    await confirm('municipal-civil-registrar', 'contact.location', 'Ground floor');
    const after = (await call('/offices/municipal-civil-registrar')).headers['etag']!;

    await workflow().revert(
      'office', await officeId('municipal-civil-registrar'), 'contact.location', 'ben@x.ph');

    expect((await call('/offices/municipal-civil-registrar')).headers['etag']).not.toBe(after);
  });
});

describe('nothing that varies by authorisation is shared-cacheable', () => {
  it('marks staff routes private and no-store', async () => {
    // TAB 13's guard. A shared cache holding one editor's view of pending
    // content and handing it to the next caller is the failure this prevents.
    for (const url of ['/staff/workflow/backlog', '/staff/history/office/anything']) {
      const response = await call(url);

      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['etag']).toBeUndefined();
    }
  });

  it('marks the session endpoint no-store', async () => {
    expect((await call('/session')).headers['cache-control']).toBe('private, no-store');
  });
});

describe('the measured budgets', () => {
  // `endpoint` is the DOCUMENTED shape and `sample` the URL actually called, so
  // the published table and the measured one are the same table rather than two
  // that happen to agree today.
  const BUDGETS: { endpoint: string; sample: string; budget: number }[] = [
    { endpoint: '/offices', sample: '/offices', budget: 60 },
    { endpoint: '/offices/{slug}', sample: '/offices/municipal-engineering', budget: 120 },
    { endpoint: '/officials', sample: '/officials', budget: 60 },
    { endpoint: '/municipality/profile', sample: '/municipality/profile', budget: 60 },
    { endpoint: '/permits', sample: '/permits', budget: 80 },
    { endpoint: '/permits/{slug}', sample: '/permits/demolition-permit', budget: 80 },
    { endpoint: '/pages', sample: '/pages', budget: 120 },
    { endpoint: '/forms', sample: '/forms', budget: 80 },
    { endpoint: '/search?q=…', sample: '/search?q=zoning', budget: 100 },
    { endpoint: '/announcements', sample: '/announcements', budget: 80 },
    { endpoint: '/announcements/count', sample: '/announcements/count', budget: 40 },
  ];

  it('publishes a budget for every endpoint it measures', () => {
    // The table in docs and the table in this test must be the same table, or
    // the published budget is decoration.
    const published = readFileSync(join(__dirname, '../docs/RESPONSE-BUDGETS.md'), 'utf8');

    for (const { endpoint, budget } of BUDGETS) {
      expect(published).toContain(`\`GET ${endpoint}\` | ${String(budget)} ms`);
    }
  });

  it.each(BUDGETS.map((b) => [b.sample, b.budget] as const))(
    '%s under a cold cache', async (url, budget) => {
    // Cold: a unique tag every time, so nothing revalidates and every query
    // runs. A budget met only when warm is a budget met only when it does not
    // matter.
    const started = process.hrtime.bigint();
    const response = await call(url, { 'if-none-match': '"deliberately-stale"' });
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(response.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(budget);
  });

  it('answers a 304 far faster than a miss', async () => {
    const etag = (await call('/offices/municipal-engineering')).headers['etag']!;

    const started = process.hrtime.bigint();
    const response = await call('/offices/municipal-engineering', { 'if-none-match': etag });
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(response.statusCode).toBe(304);
    // If a revalidation ever approaches the cost of a miss, the short-circuit
    // has been lost and the ETag is doing nothing but saving bandwidth.
    expect(elapsed).toBeLessThan(15);
  });
});
