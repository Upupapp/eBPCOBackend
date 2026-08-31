import { AnnouncementsRepository } from '../src/announcements/announcements.repository';
import { AnnouncementsService } from '../src/announcements/announcements.service';
import { renderBody } from '../src/announcements/body';
import { Harness, harness } from './http-harness';

/** TAB 07 — announcements: the capability the header already advertises. */

let api: Harness;
let service: AnnouncementsService;
let read: AnnouncementsRepository;

/** The raw Fastify response, for assertions about headers and status. */
const inject = (method: string, url: string): Promise<{
  statusCode: number; headers: Record<string, unknown>;
}> => (api.app.getHttpAdapter().getInstance() as {
  inject: (options: { method: string; url: string }) => Promise<{
    statusCode: number; headers: Record<string, unknown>;
  }>;
}).inject({ method, url });

const HOUR = 60 * 60 * 1000;
const now = () => new Date('2026-09-01T09:00:00Z');
const later = (hours: number) => new Date(now().getTime() + hours * HOUR);

beforeAll(async () => { api = await harness(); }, 120000);
afterAll(async () => { await api.close(); });

beforeEach(async () => {
  await api.db.query('delete from announcement_events');
  await api.db.query('delete from announcements');
  service = new AnnouncementsService(api.db);
  read = new AnnouncementsRepository(api.db);
});

const draft = (slug: string, actor = 'ana@castilla.gov.ph') => service.draft({
  slug, title: `Notice: ${slug}`, category: 'advisory',
  body: 'The Municipal Hall will be closed on Monday.\n\nPlease plan accordingly.',
}, actor);

describe('the lifecycle', () => {
  it('keeps a draft out of the list and out of the count', async () => {
    await draft('water-interruption');

    expect((await read.list(now(), 20, 0)).announcements).toHaveLength(0);
    expect(await read.count(now())).toBe(0);
    expect(await read.bySlug('water-interruption', now())).toBeNull();
  });

  it('publishes, and then serves it', async () => {
    await draft('water-interruption');
    const published = await service.publish('water-interruption', 'ben@castilla.gov.ph', later(-1));

    expect(published.ok).toBe(true);
    expect((await read.list(now(), 20, 0)).announcements).toHaveLength(1);
    expect(await read.count(now())).toBe(1);
    expect((await read.bySlug('water-interruption', now()))?.state).toBe('published');
  });

  it('refuses a body containing markup, at the service AND at the schema', async () => {
    // Two layers on purpose: the service so an editor gets a sentence, the
    // check constraint so no other write path can bypass it.
    const viaService = await service.draft({
      slug: 'xss', title: 'Notice', category: 'advisory',
      body: 'Hello <script>alert(1)</script>',
    }, 'ana@castilla.gov.ph');
    expect(viaService.ok).toBe(false);

    await expect(api.db.query(
      `insert into announcements (slug, title, body, category)
       values ('xss2','Notice','<img src=x onerror=alert(1)>','advisory')`),
    ).rejects.toThrow(/announcement_body_is_not_markup/);
  });

  it('refuses an unattributed action', async () => {
    expect((await draft('anon', '   ')).ok).toBe(false);
  });
});

describe('scheduling', () => {
  it('does not serve an announcement before its moment', async () => {
    // TAB 07's criterion: absent from the list AND 404 by slug until then.
    await draft('typhoon-advisory');
    await service.publish('typhoon-advisory', 'ben@castilla.gov.ph', later(3));

    expect((await read.list(now(), 20, 0)).announcements).toHaveLength(0);
    expect(await read.count(now())).toBe(0);
    expect(await read.bySlug('typhoon-advisory', now())).toBeNull();
  });

  it('serves it once the moment passes, with no deploy and no job', async () => {
    // The same stored row, read at a later clock. Nothing ran in between —
    // which is the point of deriving state instead of storing it.
    await draft('typhoon-advisory');
    await service.publish('typhoon-advisory', 'ben@castilla.gov.ph', later(3));

    expect((await read.list(later(4), 20, 0)).announcements).toHaveLength(1);
    expect((await read.bySlug('typhoon-advisory', later(4)))?.state).toBe('published');
  });
});

describe('expiry', () => {
  it('drops out of the list but stays readable by slug, flagged expired', async () => {
    // TAB 07's criterion. A link shared on Facebook must not rot the day the
    // notice lapses — say it expired, do not say it never existed.
    await draft('job-fair');
    await service.publish('job-fair', 'ben@castilla.gov.ph', later(-5), later(-1));

    expect((await read.list(now(), 20, 0)).announcements).toHaveLength(0);
    expect(await read.count(now())).toBe(0);

    const detail = await read.bySlug('job-fair', now());
    expect(detail).not.toBeNull();
    expect(detail?.state).toBe('expired');
  });

  it('refuses an expiry that precedes publication', async () => {
    await draft('backwards');
    const result = await service.publish(
      'backwards', 'ben@castilla.gov.ph', later(2), later(1));

    expect(result.ok).toBe(false);
  });
});

describe('withdrawal', () => {
  it('removes it from both surfaces without deleting it', async () => {
    await draft('mistaken-notice');
    await service.publish('mistaken-notice', 'ben@castilla.gov.ph', later(-1));

    expect((await service.withdraw('mistaken-notice', 'cara@castilla.gov.ph', 'wrong date')).ok)
      .toBe(true);

    expect((await read.list(now(), 20, 0)).announcements).toHaveLength(0);
    expect(await read.bySlug('mistaken-notice', now())).toBeNull();
    // Not deleted: the row and its history survive.
    const rows = await api.db.query<{ n: number }>(
      "select count(*)::int as n from announcements where slug = 'mistaken-notice'");
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('names who withdrew it', async () => {
    await draft('mistaken-notice');
    await service.publish('mistaken-notice', 'ben@castilla.gov.ph', later(-1));
    await service.withdraw('mistaken-notice', 'cara@castilla.gov.ph', 'wrong date');

    const history = await service.history('mistaken-notice');
    const withdrawal = history.find((event) => event.action === 'withdrawn');

    expect(withdrawal?.actor).toBe('cara@castilla.gov.ph');
    expect(withdrawal?.reason).toBe('wrong date');
  });

  it('cannot be withdrawn without an attributable event, per the DATABASE', async () => {
    // The guarantee has to hold against a write path that is not this service.
    await draft('mistaken-notice');
    await service.publish('mistaken-notice', 'ben@castilla.gov.ph', later(-1));

    await expect(api.db.query(
      "update announcements set status = 'withdrawn' where slug = 'mistaken-notice'"),
    ).rejects.toThrow(/without an event naming who withdrew it/);
  });

  it('does not silently re-publish a withdrawn announcement', async () => {
    // Bringing something back is a decision of its own, not a side effect of
    // the call that publishes drafts.
    await draft('mistaken-notice');
    await service.publish('mistaken-notice', 'ben@castilla.gov.ph', later(-1));
    await service.withdraw('mistaken-notice', 'cara@castilla.gov.ph');

    const again = await service.publish('mistaken-notice', 'ben@castilla.gov.ph', later(-1));

    expect(again.ok).toBe(false);
  });
});

describe('the body is rendered, never trusted', () => {
  it('escapes everything before it builds anything', () => {
    const html = renderBody('Beware <script>alert("x")</script> & "quotes"');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('turns blank lines into paragraphs and single newlines into breaks', () => {
    const html = renderBody('One\nstill one\n\nTwo');

    expect(html).toContain('<p>One<br>still one</p>');
    expect(html).toContain('<p>Two</p>');
  });

  it('links http and https only', () => {
    const html = renderBody('See https://castilla-ebpco.online/notice for details');

    expect(html).toContain('<a href="https://castilla-ebpco.online/notice"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('never builds a link from a javascript: URL', () => {
    // A `javascript:` URL is a script wearing a link's costume.
    const html = renderBody('Click javascript:alert(1) now');

    expect(html).not.toContain('<a href="javascript:');
  });
});

describe('the header count endpoint', () => {
  it('counts exactly what the list shows', async () => {
    await draft('a'); await service.publish('a', 'ben', later(-2));
    await draft('b'); await service.publish('b', 'ben', later(-1));
    await draft('c'); await service.publish('c', 'ben', later(5));            // scheduled
    await draft('d'); await service.publish('d', 'ben', later(-5), later(-1)); // expired
    await draft('e');                                                          // draft

    const { announcements, total } = await read.list(now(), 20, 0);

    expect(await read.count(now())).toBe(2);
    expect(announcements).toHaveLength(2);
    expect(total).toBe(2);
  });

  it('answers over HTTP against the real clock', async () => {
    // Deliberately the WALL clock, not this file's fixed one: the endpoint
    // calls `new Date()`, and a test that pinned the clock here would pass
    // against a controller that never read the time at all.
    await draft('a');
    await service.publish('a', 'ben', new Date(Date.now() - HOUR));
    await draft('b');
    await service.publish('b', 'ben', new Date(Date.now() + 24 * HOUR)); // scheduled

    const response = await api.get('/announcements/count');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 1 });
  });

  it('sets a public cache header, because every page load calls it', async () => {
    const response = await inject('GET', '/announcements/count');

    expect(response.headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('the HTTP surface', () => {
  it('orders newest first and paginates', async () => {
    for (const [slug, hoursAgo] of [['oldest', -9], ['middle', -5], ['newest', -1]] as const) {
      await draft(slug);
      await service.publish(slug, 'ben', later(hoursAgo));
    }

    const first = await read.list(now(), 2, 0);
    expect(first.announcements.map((a) => a.slug)).toEqual(['newest', 'middle']);
    expect(first.total).toBe(3);

    const second = await read.list(now(), 2, 2);
    expect(second.announcements.map((a) => a.slug)).toEqual(['oldest']);
  });

  it('404s a slug that is a draft, so its existence is not leaked', async () => {
    await draft('internal-only');

    expect((await api.get('/announcements/internal-only')).status).toBe(404);
  });

  it('rejects a nonsense limit rather than guessing', async () => {
    expect((await api.get('/announcements?limit=-4')).status).toBe(400);
  });

  it('exposes NO write route in this TAB', async () => {
    // Staff authentication is TAB 11. An unauthenticated POST that publishes to
    // a municipal government's homepage is not a feature awaiting a guard.
    const posted = await inject('POST', '/announcements');
    const deleted = await inject('DELETE', '/announcements/anything');

    expect(posted.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);
  });
});
