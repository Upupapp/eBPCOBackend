import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/persistence/migrator';
import { Seeder } from '../src/seed/seeder';
import { ExtractedPortalData } from '../src/seed/extracted';
import { ConfirmationService } from '../src/workflow/confirmation.service';

/**
 * TAB 02's acceptance criteria, against the real seeded backlog.
 *
 * Seeded rather than hand-built, because the criterion is about the backlog
 * that actually exists at seed time — 2 unconfirmed heads, 9 unconfirmed
 * contacts, 19 unconfirmed permits, 1 unconfirmed ex-officio seat. A fixture
 * written to match those numbers would assert the fixture.
 */

const data = JSON.parse(
  readFileSync(join(__dirname, '../contract/portal-data.json'), 'utf8'),
) as ExtractedPortalData;

let db: PGlite;
let workflow: ConfirmationService;

beforeEach(async () => {
  db = await PGlite.create();
  await migrate(db, join(__dirname, '../db/migrations'));
  await new Seeder(db).run(data);
  workflow = new ConfirmationService(db);
});

afterEach(async () => {
  await db.close();
});

const anOffice = async (): Promise<string> =>
  (await db.query<{ id: string }>(
    "select id from offices where slug = 'municipal-treasurer'")).rows[0]!.id;

const aProposal = async (over: Partial<Parameters<ConfirmationService['propose']>[0]> = {}) => {
  const officeId = await anOffice();
  return workflow.propose({
    entityType: 'office', entityId: officeId, fieldName: 'contact.telephone',
    proposedValue: '(056) 123-4567',
    sourceDescription: 'the LGU Citizen\'s Charter, page 12, read at the counter',
    sourcedOn: '2026-08-30', method: 'official-document', proposedBy: 'editor@castilla.gov.ph',
    ...over,
  });
};

describe('proposals are not live', () => {
  it('changes nothing a citizen can read', async () => {
    const before = await db.query<{ state: string }>(
      `select state::text from field_state where field_name = 'contact.telephone'
        and entity_id = $1`, [await anOffice()],
    );

    await aProposal();

    const after = await db.query<{ state: string }>(
      `select state::text from field_state where field_name = 'contact.telephone'
        and entity_id = $1`, [await anOffice()],
    );
    expect(after.rows[0]?.state).toBe(before.rows[0]?.state);
    expect(after.rows[0]?.state).not.toBe('confirmed');
  });

  it("refuses a proposal whose source is 'LGU'", async () => {
    // Not a source. A description someone else could check is the floor, and
    // it is held here so a person gets a sentence rather than a constraint.
    const result = await aProposal({ sourceDescription: 'LGU' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('source-too-thin');
  });

  it('allows only one open proposal per field', async () => {
    await aProposal();
    const second = await aProposal({ proposedValue: '(056) 999-0000' });

    // Two people proposing different values is a conversation, not a race.
    expect(second.ok).toBe(false);
  });
});

describe('the four-eyes rule', () => {
  it('refuses the same account confirming its own contact-field proposal', async () => {
    const proposed = await aProposal({ proposedBy: 'ana@castilla.gov.ph' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const result = await workflow.confirm(proposed.value, 'ana@castilla.gov.ph');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('four-eyes');
  });

  it("refuses the same account confirming an official's name", async () => {
    const official = (await db.query<{ id: string }>(
      "select id from officials where name like '%Mendoza%' limit 1")).rows[0]!.id;
    const proposed = await workflow.propose({
      entityType: 'official', entityId: official, fieldName: 'name',
      proposedValue: 'Isagani B. Mendoza',
      sourceDescription: 'the 2025 COMELEC certificate of canvass, read directly',
      sourcedOn: '2026-08-30', method: 'official-document', proposedBy: 'ana@castilla.gov.ph',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    expect((await workflow.confirm(proposed.value, 'ana@castilla.gov.ph')).ok).toBe(false);
  });

  it('accepts a different account', async () => {
    // The other half. Without it the refusals above pass equally against a
    // workflow that refuses everyone.
    const proposed = await aProposal({ proposedBy: 'ana@castilla.gov.ph' });
    if (!proposed.ok) return;

    expect((await workflow.confirm(proposed.value, 'ben@castilla.gov.ph')).ok).toBe(true);
  });

  it('lets one person do both for a fact that is not about a person', async () => {
    // A control that applies to every comma is one staff route around, and a
    // control that gets routed around protects nothing. An office's about text
    // is a fact about the municipality.
    const proposed = await aProposal({
      fieldName: 'aboutText', proposedValue: 'The Municipal Treasurer collects local revenue.',
      proposedBy: 'ana@castilla.gov.ph',
    });
    if (!proposed.ok) return;

    expect((await workflow.confirm(proposed.value, 'ana@castilla.gov.ph')).ok).toBe(true);
  });
});

describe('confirmation writes the source and the state together', () => {
  it('leaves a provenance row for the confirmed value', async () => {
    const proposed = await aProposal();
    if (!proposed.ok) return;
    await workflow.confirm(proposed.value, 'ben@castilla.gov.ph');

    const sources = await db.query<{ n: number }>(
      `select count(*)::int as n from provenance
        where entity_id = $1 and field_name = 'contact.telephone'`, [await anOffice()],
    );

    expect(sources.rows[0]!.n).toBeGreaterThan(0);
  });

  it('produces ONE confirmation from two concurrent attempts', async () => {
    // The criterion, stated exactly: one confirmed value and one rejection,
    // never two provenance rows racing. The status transition is the lock, so
    // there is no window between checking and acting.
    const proposed = await aProposal();
    if (!proposed.ok) return;

    const [a, b] = await Promise.all([
      workflow.confirm(proposed.value, 'ben@castilla.gov.ph'),
      workflow.confirm(proposed.value, 'cara@castilla.gov.ph'),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const sources = await db.query<{ n: number }>(
      `select count(*)::int as n from provenance
        where entity_id = $1 and field_name = 'contact.telephone'`, [await anOffice()],
    );
    expect(sources.rows[0]!.n).toBe(1);
  });
});

describe('reverting keeps both claims readable in order', () => {
  it('returns the field to pending and leaves the trail', async () => {
    const officeId = await anOffice();
    const first = await aProposal();
    if (!first.ok) return;
    await workflow.confirm(first.value, 'ben@castilla.gov.ph');

    expect((await workflow.revert('office', officeId, 'contact.telephone',
      'ben@castilla.gov.ph')).ok).toBe(true);

    const second = await aProposal({ proposedValue: '(056) 222-3333' });
    if (!second.ok) return;
    await workflow.confirm(second.value, 'cara@castilla.gov.ph');

    const trail = await db.query<{ source_description: string; recorded_at: string }>(
      `select source_description from provenance
        where entity_id = $1 and field_name = 'contact.telephone'
        order by recorded_at`, [officeId],
    );

    // Both claims survive. The LGU contradicting itself is resolvable only if
    // both statements can be read, in the order they were made.
    expect(trail.rows.length).toBe(2);
  });

  it('refuses to revert something that was never confirmed', async () => {
    expect((await workflow.revert('office', await anOffice(), 'contact.email', 'ben'))
      .ok).toBe(false);
  });
});

describe('the backlog is the LGU’s to-do list', () => {
  it('names the 2 unconfirmed office heads', async () => {
    const backlog = await workflow.backlog();
    const heads = backlog.filter((e) => e.pendingFields.includes('head'));

    expect(heads).toHaveLength(2);
  });

  it('names the 19 unconfirmed permits', async () => {
    const backlog = await workflow.backlog();

    expect(backlog.filter((e) => e.entityType === 'permit')).toHaveLength(19);
  });

  it('groups an office’s contact fields rather than listing four of them', async () => {
    // A person confirming an office's contact does telephone, email, location
    // and hours in one sitting. A flat list describes the same backlog and
    // reads as four times the work.
    const backlog = await workflow.backlog();
    const withContacts = backlog.filter(
      (e) => e.pendingFields.some((f) => f.startsWith('contact.')),
    );

    expect(withContacts.length).toBeGreaterThan(0);
    expect(withContacts[0]!.pendingFields.filter((f) => f.startsWith('contact.')).length)
      .toBeGreaterThan(1);
  });

  it('names the 9 offices whose contact is a placeholder', async () => {
    // The Master Command's figure, and it earned its keep: the extractor found
    // only 8 until 2026-08-30, because the Municipal Administrator's contact is
    // `{ ...placeholderContact(), hours: '...' }` and a SPREAD was silently
    // dropped. The office read as a sourced fact. See the spread test below.
    const rows = await db.query<{ n: number }>(
      'select count(*)::int as n from offices where contact_is_placeholder');

    expect(rows.rows[0]!.n).toBe(9);
  });

  it('names the 1 unconfirmed ex-officio seat', async () => {
    // Castilla's ABC President. Every source found named the PROVINCIAL-level
    // president, a different office, so the portal declines to attribute it.
    const backlog = await workflow.backlog();
    const seats = backlog.filter(
      (e) => e.entityType === 'official' && e.label === 'Name pending confirmation',
    );

    expect(seats).toHaveLength(1);
  });

  it('carries a label a person can read, not a UUID', async () => {
    // This list is handed to LGU staff as their content to-do list. A column of
    // UUIDs is a list nobody can act on.
    const backlog = await workflow.backlog();

    for (const entry of backlog) {
      expect(entry.label).not.toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('a spread contact is still a placeholder', () => {
  it("does not let the Administrator's contact read as confirmed", async () => {
    // The regression. `{ ...placeholderContact(), hours: '...' }` carries
    // isPlaceholder: true through the spread; dropping it made the office look
    // sourced. All four fields must be pending.
    // Asserted as the RECORDED fact, not as four pending states. Under the
    // original defect those four states were pending anyway — for the
    // unrelated reason that the contact's comment carries no date — so a
    // state-based assertion passed while the bug was live.
    const office = await db.query<{ placeholder: boolean }>(
      `select contact_is_placeholder as placeholder from offices
        where slug = 'municipal-administrator'`);

    expect(office.rows[0]!.placeholder).toBe(true);

    const states = await db.query<{ state: string }>(
      `select f.state::text as state from field_state f
         join offices o on o.id::text = f.entity_id
        where o.slug = 'municipal-administrator' and f.field_name like 'contact.%'`);
    expect(states.rows).toHaveLength(4);
    for (const row of states.rows) expect(row.state).toBe('pending');
  });

  it('keeps the override written beside the spread', async () => {
    // The Administrator's published hours are a deliberate real value. Pending
    // is not a reason to lose it — the backend still has to reproduce what the
    // portal shows a citizen.
    const hours = await db.query<{ value: string }>(
      `select c.value from office_contacts c join offices o on o.id = c.office_id
        where o.slug = 'municipal-administrator' and c.field_name = 'hours'`);

    expect(hours.rows[0]?.value).toContain('no noon break');
  });
});
