import { PagesRepository } from '../src/pages/pages.repository';
import { PagesService } from '../src/pages/pages.service';
import { Harness, harness } from './http-harness';

/** TAB 09 — the narrative pages, and the incompleteness that is on purpose. */

let api: Harness;
let pages: PagesRepository;
let service: PagesService;

beforeAll(async () => { api = await harness(); }, 180000);
afterAll(async () => { await api.close(); });

beforeEach(() => {
  pages = new PagesRepository(api.db);
  service = new PagesService(api.db);
});

describe('the five pages seed with their real state', () => {
  it('seeds exactly the five keys the client references by meaning', async () => {
    const keys = (await pages.list()).map((p) => p.key);

    expect(keys).toEqual([
      'history', 'vision', 'mission', 'seal-description', 'privacy-policy',
    ]);
  });

  it('leaves three pending and two confirmed', async () => {
    // TAB 09's criterion, stated exactly.
    const all = await pages.list();

    expect(all.filter((p) => p.state === 'confirmed').map((p) => p.key))
      .toEqual(['history', 'mission']);
    expect(all.filter((p) => p.state === 'pending').map((p) => p.key))
      .toEqual(['vision', 'seal-description', 'privacy-policy']);
  });

  it('carries the real text, not source code', async () => {
    // The history, mission and seal texts are written as multi-line string
    // CONCATENATIONS in the portal. Until 2026-08-31 the extractor recorded
    // those as opaque expressions, so the body would have arrived as source
    // with quote marks and plus signs in it.
    const history = await pages.byKey('history');

    expect(history?.body).toContain('Before 1827');
    expect(history?.body).toContain('annexed as one of its constituent towns');
    expect(history?.body).not.toContain("' +");
    expect(history?.body.length).toBeGreaterThan(900);
  });
});

describe('a pending page is served, flagged, never blanked', () => {
  it('distinguishes pending from confirmed without reading the body', async () => {
    // TAB 09's criterion. A client must not have to string-match prose to know
    // whether to render the 'pending publication' notice.
    const vision = await pages.byKey('vision');
    const history = await pages.byKey('history');

    expect(vision?.state).toBe('pending');
    expect(vision?.isPlaceholder).toBe(true);
    expect(history?.state).toBe('confirmed');
    expect(history?.isPlaceholder).toBe(false);
  });

  it('still serves the placeholder text, so the page is not empty', async () => {
    const vision = await pages.byKey('vision');

    expect(vision?.body).toContain('will be published here once confirmed');
  });

  it('did not complete the Vision statement from a search snippet', async () => {
    // TAB 09's guard, held as a test. Only a truncated fragment — 'A premier
    // agri-ecotourism…' — could ever be found, and publishing a half-quote as
    // a municipality's official Vision is worse than admitting it is unknown.
    const vision = await pages.byKey('vision');

    expect(vision?.body).not.toMatch(/premier agri-ecotourism/i);
    expect(vision?.isPlaceholder).toBe(true);
  });

  it('did not merge the seal description with a symbolic interpretation', async () => {
    // The description transcribes what is visually present and explicitly
    // leaves heraldic meaning to the LGU.
    const seal = await pages.byKey('seal-description');

    expect(seal?.body).toContain('leaping dolphin');
    expect(seal?.body).toContain('symbolism is pending confirmation');
    expect(seal?.isPlaceholder).toBe(true);
  });
});

describe('revision history', () => {
  it('keeps the placeholder retrievable after the LGU replaces it', async () => {
    // TAB 09's criterion, and the reason revisions exist at all.
    const placeholder = (await pages.byKey('privacy-policy'))!.body;
    expect(placeholder).toContain('placeholder notice');

    const replaced = await service.replace('privacy-policy', {
      title: 'Privacy Policy',
      body: 'The Municipality of Castilla collects no personal data through this portal. '
        + 'The site embeds Google Fonts and an OpenStreetMap frame; both receive your IP '
        + 'address when a page loads.',
      isPlaceholder: false,
    }, 'ana@castilla.gov.ph');
    expect(replaced.ok).toBe(true);

    const current = await pages.byKey('privacy-policy');
    expect(current?.body).toContain('OpenStreetMap');

    const history = await pages.revisions('privacy-policy');
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe(placeholder);
    expect(history[0]?.author).toBe('ana@castilla.gov.ph');
  });

  it('can state third-party data flows', async () => {
    // The model must not PREVENT the eventual wording. The site currently
    // claims it collects no personal data while embedding Google Fonts and an
    // OpenStreetMap frame, both of which disclose a visitor's IP to a third
    // party — whatever the LGU eventually says, it has to be sayable here.
    //
    // Self-contained on purpose: this originally passed only because an earlier
    // test in the file had already replaced the body, which is a test asserting
    // its neighbour rather than the model.
    await service.replace('privacy-policy', {
      title: 'Privacy Policy',
      body: 'This portal embeds Google Fonts (fonts.gstatic.com) and an OpenStreetMap frame. '
        + 'Both receive your IP address when a page loads. No account or form data is collected.',
      isPlaceholder: false,
    }, 'cara@castilla.gov.ph');

    const page = await pages.byKey('privacy-policy');

    expect(page?.body).toContain('OpenStreetMap');
    expect(page?.body).toContain('Google Fonts');
    expect(page?.body).toContain('IP address');
  });

  it('returns a replaced page to pending, because the new words are unsourced', async () => {
    await service.replace('history', {
      title: 'History of Castilla', body: 'A shorter history, newly written.',
      isPlaceholder: false,
    }, 'ben@castilla.gov.ph');

    expect((await pages.byKey('history'))?.state).toBe('pending');
  });

  it('refuses an unattributed edit', async () => {
    expect((await service.replace('mission', {
      title: 'Mission', body: 'text', isPlaceholder: false,
    }, '   ')).ok).toBe(false);
  });

  it('archives before it overwrites, so an interruption loses the edit not the history', async () => {
    const before = (await pages.byKey('mission'))!.body;
    await service.replace('mission', {
      title: 'Mission', body: 'Replacement one.', isPlaceholder: false,
    }, 'ana@castilla.gov.ph');
    await service.replace('mission', {
      title: 'Mission', body: 'Replacement two.', isPlaceholder: false,
    }, 'ben@castilla.gov.ph');

    const history = await pages.revisions('mission');

    expect(history.map((r) => r.body)).toEqual(['Replacement one.', before]);
  });
});

describe('the HTTP surface', () => {
  it('serves a page by its stable key', async () => {
    const { status, body } = await api.get('/pages/mission');

    expect(status).toBe(200);
    expect((body as { key: string }).key).toBe('mission');
  });

  it('404s a key it does not publish', async () => {
    expect((await api.get('/pages/tourism')).status).toBe(404);
  });

  it('exposes NO write route in this TAB', async () => {
    // Staff authentication is TAB 11. An unauthenticated route that rewrites a
    // municipality's privacy policy is not a feature awaiting a guard.
    const server = api.app.getHttpAdapter().getInstance() as {
      inject: (o: { method: string; url: string }) => Promise<{ statusCode: number }>;
    };

    expect((await server.inject({ method: 'PUT', url: '/pages/privacy-policy' })).statusCode)
      .toBe(404);
    expect((await server.inject({ method: 'POST', url: '/pages' })).statusCode).toBe(404);
  });
});
