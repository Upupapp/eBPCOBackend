import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FormImporter } from '../src/forms/form-importer';
import { Harness, harness } from './http-harness';

/** TAB 06 — bundled application forms: storage, integrity, and the download. */

const BUNDLE = '/Users/user/eBPCO-Website/castilla-lgu-portal/public/assets/permits';

const bundledFiles = () => readdirSync(BUNDLE)
  .filter((name) => name.endsWith('.pdf'))
  .map((filename) => ({ filename, bytes: readFileSync(join(BUNDLE, filename)) }));

let api: Harness;
let files: ReturnType<typeof bundledFiles>;

/** The raw Fastify response, because these assertions are about BYTES. */
const inject = (url: string): Promise<{
  statusCode: number; headers: Record<string, unknown>; body: string; rawPayload: Buffer;
}> => (api.app.getHttpAdapter().getInstance() as {
  inject: (options: { method: string; url: string }) => Promise<{
    statusCode: number; headers: Record<string, unknown>; body: string; rawPayload: Buffer;
  }>;
}).inject({ method: 'GET', url });

beforeAll(async () => {
  api = await harness();
  files = bundledFiles();
  await new FormImporter(api.db).run(files);
}, 300000);

afterAll(async () => { await api.close(); });

const list = async () => {
  const { status, body } = await api.get('/forms');
  expect(status).toBe(200);
  return (body as { forms: { familySlug: string; originalFilename: string; checksum: string;
    pageCount: number; byteSize: number; contentType: string; revisionLabel?: string }[] }).forms;
};

describe('importing the bundle', () => {
  it('stores all 13 with a checksum', async () => {
    const forms = await list();

    expect(forms).toHaveLength(13);
    for (const form of forms) expect(form.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the checksum of the bytes it was actually given', async () => {
    // The guard that matters: these are the LGU's documents, never
    // re-generated. A stored checksum that does not equal sha256 of the file on
    // disk means something in this pipeline rewrote a government form.
    const forms = await list();

    for (const file of files) {
      const stored = forms.find((f) => f.originalFilename === file.filename);
      expect(stored?.checksum).toBe(createHash('sha256').update(file.bytes).digest('hex'));
      expect(stored?.byteSize).toBe(file.bytes.length);
    }
  });

  it('creates no new revision when an unchanged file is re-imported', async () => {
    // TAB 06's criterion, measured rather than asserted.
    const before = await api.db.query<{ n: number }>('select count(*)::int as n from forms');

    const report = await new FormImporter(api.db).run(files);

    expect(report.imported).toBe(0);
    expect(report.unchanged).toBe(13);
    expect(report.superseded).toBe(0);
    const after = await api.db.query<{ n: number }>('select count(*)::int as n from forms');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('reads the revision printed on the form, and only where one is printed', async () => {
    const forms = await list();
    const labelled = forms.filter((f) => f.revisionLabel !== undefined);

    expect(labelled.map((f) => f.revisionLabel).sort()).toEqual([
      'BFP-QSF-FSED-001 REV.02 (08.24.20)',
      'BFP-QSF-FSED-002 REV.02 (08.24.20)',
      'FM-MPD-01, Updated as of August 2024',
    ]);
    // The other 10 print none. NULL says so rather than inventing 'v1'.
    expect(forms).toHaveLength(13);
  });

  it('records page counts that match an independent reader', async () => {
    // Cross-checked against macOS Spotlight metadata, because a page count read
    // by the same code that wrote it proves nothing. One form has a nested page
    // tree with /Count 1 AND 2; taking the first would have stored 1.
    const forms = await list();

    for (const form of forms) {
      const independent = Number(execFileSync('mdls',
        ['-name', 'kMDItemNumberOfPages', '-raw', join(BUNDLE, form.originalFilename)],
        { encoding: 'utf8' }).trim());
      expect(form.pageCount).toBe(independent);
    }
  });
});

describe('one file, many permits', () => {
  it('stores the shared building permit form once', async () => {
    // TAB 06's criterion. Duplicating the bytes per permit would give one
    // document three checksums and three chances to go stale.
    const stored = await api.db.query<{ n: number }>(
      `select count(*)::int as n from forms
        where original_filename = 'Building-Permit-Unified-Application-Form.pdf'`);

    expect(stored.rows[0]!.n).toBe(1);
  });

  it('resolves the 3 building permit variants to that one file', async () => {
    const rows = await api.db.query<{ slug: string }>(
      `select p.slug from permits p
         join permit_forms pf on pf.permit_id = p.id and pf.role = 'application'
         join forms f on f.id = pf.form_id
        where f.original_filename = 'Building-Permit-Unified-Application-Form.pdf'
        order by p.ordinal`);

    expect(rows.rows.map((r) => r.slug)).toEqual([
      'building-permit-new-construction',
      'building-permit-renovation-alteration',
      'building-permit-addition-extension',
    ]);
  });

  it('links the checklist under its own role, not as an application form', async () => {
    const rows = await api.db.query<{ n: number }>(
      `select count(*)::int as n from permit_forms pf
         join forms f on f.id = pf.form_id
        where f.original_filename = 'Building-Permit-and-Occupancy-Checklist.pdf'
          and pf.role = 'checklist'`);

    expect(rows.rows[0]!.n).toBe(4);
  });
});

describe('reconciliation names what did not match', () => {
  it('reports no orphans and no dangling references today', async () => {
    // TAB 06 was written against portal commit dbacca5, where the Building
    // Permit and Occupancy Checklist was referenced by NO permit and shipped
    // unreachable. The portal lane has since wired it to 4 permits, so the
    // orphan it names no longer exists. The mechanism is what matters and it is
    // asserted below; this records that the finding is closed.
    const report = await new FormImporter(api.db).run(files);

    expect(report.orphans).toEqual([]);
    expect(report.dangling).toEqual([]);
  });

  it('reports a file no permit references, rather than attaching it to a guess', async () => {
    // The mechanism, proven by introducing an orphan. Without this the test
    // above passes against a reconciler that reports nothing at all.
    await new FormImporter(api.db).run([
      ...files,
      { filename: 'Unreferenced-Extra-Form.pdf',
        bytes: readFileSync(join(BUNDLE, 'Sanitary-Permit-Form.pdf')) },
    ]);

    const report = await new FormImporter(api.db).run([
      ...files,
      { filename: 'Unreferenced-Extra-Form.pdf',
        bytes: readFileSync(join(BUNDLE, 'Sanitary-Permit-Form.pdf')) },
    ]);

    expect(report.orphans).toEqual(['Unreferenced-Extra-Form.pdf']);
    const attached = await api.db.query<{ n: number }>(
      `select count(*)::int as n from permit_forms pf join forms f on f.id = pf.form_id
        where f.original_filename = 'Unreferenced-Extra-Form.pdf'`);
    expect(attached.rows[0]!.n).toBe(0);

    await api.db.query(
      "delete from forms where original_filename = 'Unreferenced-Extra-Form.pdf'");
  });

  it('reports a permit citing a form nobody bundled', async () => {
    // That link is already dead on the live site; the import is where it
    // becomes visible.
    await api.db.query(
      `update permits set form_url = '/assets/permits/Does-Not-Exist.pdf'
        where slug = 'demolition-permit'`);

    const report = await new FormImporter(api.db).run(files);

    expect(report.dangling).toEqual(['Does-Not-Exist.pdf']);

    await api.db.query("update permits set form_url = null where slug = 'demolition-permit'");
  });
});

describe('the download', () => {
  const download = (url: string) => inject(url);

  it('serves the exact bytes, with the right type and a recognisable filename', async () => {
    const response = await download('/forms/fsec-for-building-permit-bfp/download');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition'])
      .toBe('attachment; filename="FSEC-for-Building-Permit-BFP.pdf"');

    const original = readFileSync(join(BUNDLE, 'FSEC-for-Building-Permit-BFP.pdf'));
    expect(createHash('sha256').update(response.rawPayload).digest('hex'))
      .toBe(createHash('sha256').update(original).digest('hex'));
  });

  it('404s with JSON, never HTML and never 200', async () => {
    // TAB 06's criterion. A citizen whose browser saved an HTML error page as a
    // .pdf would carry it to the counter and find out there.
    const response = await download('/forms/dog-licence-form/download');

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).not.toMatch(/<html/i);
  });

  it('is not behind authentication', async () => {
    // Blank public forms. Gating them defeats the portal's purpose.
    const response = await download('/forms/sanitary-permit-form/download');

    expect(response.statusCode).toBe(200);
  });
});

describe('superseding keeps the prior revision retrievable', () => {
  const download = (url: string) => inject(url);

  it('serves the new bytes by slug and the old bytes by checksum', async () => {
    // An application filed on last year's form is still a real application.
    const original = readFileSync(join(BUNDLE, 'Sanitary-Permit-Form.pdf'));
    const oldChecksum = createHash('sha256').update(original).digest('hex');
    const revised = Buffer.concat([original, Buffer.from('\n% revision 2\n')]);

    const report = await new FormImporter(api.db).run([
      { filename: 'Sanitary-Permit-Form.pdf', bytes: revised },
    ]);
    expect(report.superseded).toBe(1);
    expect(report.imported).toBe(1);

    const current = await download('/forms/sanitary-permit-form/download');
    expect(createHash('sha256').update(current.rawPayload).digest('hex'))
      .toBe(createHash('sha256').update(revised).digest('hex'));

    const prior = await download(
      `/forms/sanitary-permit-form/download?checksum=${oldChecksum}`);
    expect(prior.statusCode).toBe(200);
    expect(createHash('sha256').update(prior.rawPayload).digest('hex')).toBe(oldChecksum);

    const revisions = await api.get('/forms/sanitary-permit-form/revisions');
    expect((revisions.body as { revisions: unknown[] }).revisions).toHaveLength(2);
  });


});
