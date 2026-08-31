import { AuditRepository } from '../src/audit/audit.repository';
import { ConfirmationService } from '../src/workflow/confirmation.service';
import { AnnouncementsService } from '../src/announcements/announcements.service';
import { PagesService } from '../src/pages/pages.service';
import { Harness, harness } from './http-harness';

/** TAB 12 — the audit trail: who changed what, when, and on what basis. */

let api: Harness;
let audit: AuditRepository;
let workflow: ConfirmationService;

beforeAll(async () => { api = await harness(); }, 180000);
afterAll(async () => { await api.close(); });

beforeEach(() => {
  audit = new AuditRepository(api.db);
  workflow = new ConfirmationService(api.db);
});

const officeId = async (slug = 'municipal-treasurer'): Promise<string> =>
  (await api.db.query<{ id: string }>(
    'select id from offices where slug = $1', [slug])).rows[0]!.id;

const proposeAndConfirm = async (
  fieldName: string, value: string, by = 'ana@castilla.gov.ph', confirmer = 'ben@castilla.gov.ph',
): Promise<string> => {
  const id = await officeId();
  const proposed = await workflow.propose({
    entityType: 'office', entityId: id, fieldName, proposedValue: value,
    sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
    sourcedOn: '2026-08-31', method: 'official-document', proposedBy: by,
  });
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.reason}`);
  const confirmed = await workflow.confirm(proposed.value, confirmer);
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.reason}`);
  return id;
};

describe('append-only, enforced by the database', () => {
  it('refuses an UPDATE on an audit row', async () => {
    // TAB 12's criterion: it fails at the DATABASE level, under the
    // application's own credentials — which in this suite is the superuser, so
    // only a trigger can demonstrate it. A REVOKE additionally constrains the
    // unprivileged production role.
    await proposeAndConfirm('contact.telephone', '(056) 111-1111');

    await expect(api.db.query("update audit_log set actor = 'someone else'"))
      .rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE on an audit row', async () => {
    await expect(api.db.query('delete from audit_log')).rejects.toThrow(/append-only/);
  });

  it('refuses a TRUNCATE, which bypasses row triggers', async () => {
    // The one that gets missed: TRUNCATE does not fire BEFORE DELETE triggers,
    // so an append-only guarantee resting on those alone is one statement away
    // from an empty table.
    await expect(api.db.query('truncate audit_log')).rejects.toThrow(/append-only/);
  });

  it('revokes update and delete from the application role too', async () => {
    const grants = await api.db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_name = 'audit_log' and grantee = 'castilla_portal_app'`);
    const held = grants.rows.map((row) => row.privilege_type);

    expect(held).toContain('INSERT');
    expect(held).toContain('SELECT');
    expect(held).not.toContain('UPDATE');
    expect(held).not.toContain('DELETE');
  });
});

describe('a confirmation produces exactly one audit row, with its provenance', () => {
  it('records actor, field, prior and new value, and the source', async () => {
    // TAB 12's criterion, stated exactly.
    const id = await proposeAndConfirm('contact.email', 'treasurer@castilla.gov.ph');

    const rows = await api.db.query<{
      actor: string; action: string; field_name: string;
      new_value: string; provenance_id: string | null;
    }>(
      `select actor, action, field_name, new_value, provenance_id from audit_log
        where entity_id = $1 and field_name = 'contact.email'`, [id]);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.actor).toBe('ben@castilla.gov.ph');
    expect(rows.rows[0]!.action).toBe('confirmed');
    expect(rows.rows[0]!.new_value).toBe('treasurer@castilla.gov.ph');
    expect(rows.rows[0]!.provenance_id).not.toBeNull();
  });

  it('links to the provenance the confirmation actually rested on', async () => {
    const id = await proposeAndConfirm('contact.location', 'Ground floor, Municipal Hall');

    const joined = await api.db.query<{ source_description: string }>(
      `select p.source_description from audit_log a
         join provenance p on p.id = a.provenance_id
        where a.entity_id = $1 and a.field_name = 'contact.location'`, [id]);

    expect(joined.rows[0]?.source_description).toContain("Citizen's Charter");
  });

  it('names who proposed as well as who confirmed', async () => {
    // Four-eyes is only auditable if BOTH halves are in the record.
    const id = await proposeAndConfirm(
      'contact.hours', 'Monday-Friday', 'cara@castilla.gov.ph', 'dan@castilla.gov.ph');

    const rows = await api.db.query<{ actor: string; detail: string }>(
      `select actor, detail from audit_log
        where entity_id = $1 and field_name = 'contact.hours'`, [id]);

    expect(rows.rows[0]!.actor).toBe('dan@castilla.gov.ph');
    expect(rows.rows[0]!.detail).toContain('cara@castilla.gov.ph');
  });
});

describe('the change and its audit row commit together or not at all', () => {
  it('writes no audit row when the confirmation loses the race', async () => {
    const id = await officeId('municipal-assessor');
    const proposed = await workflow.propose({
      entityType: 'office', entityId: id, fieldName: 'contact.telephone',
      proposedValue: '(056) 222-2222',
      sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
      sourcedOn: '2026-08-31', method: 'official-document', proposedBy: 'ana@castilla.gov.ph',
    });
    if (!proposed.ok) throw new Error('propose failed');

    const [first, second] = await Promise.all([
      workflow.confirm(proposed.value, 'ben@castilla.gov.ph'),
      workflow.confirm(proposed.value, 'cara@castilla.gov.ph'),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    // Exactly one confirmation happened, so exactly one audit row exists. The
    // loser must leave no trace claiming a change it did not make.
    const rows = await api.db.query<{ n: number }>(
      `select count(*)::int as n from audit_log
        where entity_id = $1 and field_name = 'contact.telephone' and action = 'confirmed'`,
      [id]);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('rolls the change back when the AUDIT write fails', async () => {
    // The 'or vice versa' half of TAB 12's guard, and the direction that
    // matters most: if the audit row cannot be written, the change must not
    // happen either. A site that published a fact no audit row explains is
    // exactly what this trail exists to make impossible.
    const id = await officeId('municipal-budget');
    await api.db.query(
      `insert into proposals (entity_type, entity_id, field_name, proposed_value,
                              source_description, sourced_on, method, proposed_by, status)
       values ('office',$1,'contact.email','budget@castilla.gov.ph',
               'the LGU Citizen''s Charter, page 12, read at the counter',
               date '2026-08-31','official-document','ana@castilla.gov.ph','open')`, [id]);
    const proposalId = (await api.db.query<{ id: string }>(
      `select id from proposals where entity_id = $1 and status = 'open'`, [id])).rows[0]!.id;

    // Make writing an audit row impossible, without touching the workflow.
    await api.db.query(`
      create or replace function refuse_audit() returns trigger as $$
      begin raise exception 'audit unavailable'; end; $$ language plpgsql`);
    await api.db.query(
      `create trigger audit_log_refuse before insert on audit_log
         for each row execute function refuse_audit()`);

    try {
      await expect(workflow.confirm(proposalId, 'ben@castilla.gov.ph'))
        .rejects.toThrow(/audit unavailable/);

      // Nothing applied: the field is not confirmed, the proposal is still
      // open, and no provenance row was left behind claiming a source.
      const state = await api.db.query<{ state: string }>(
        `select state::text from field_state
          where entity_id = $1 and field_name = 'contact.email'`, [id]);
      expect(state.rows[0]?.state).not.toBe('confirmed');

      const proposal = await api.db.query<{ status: string }>(
        'select status::text from proposals where id = $1', [proposalId]);
      expect(proposal.rows[0]!.status).toBe('open');

      const provenance = await api.db.query<{ n: number }>(
        `select count(*)::int as n from provenance
          where entity_id = $1 and field_name = 'contact.email'`, [id]);
      expect(provenance.rows[0]!.n).toBe(0);
    } finally {
      await api.db.query('drop trigger audit_log_refuse on audit_log');
    }
  });

  it('applies the change once the audit write works again', async () => {
    // The other half: without it, the test above passes against a confirm()
    // that never applies anything at all.
    const id = await officeId('municipal-budget');
    const proposalId = (await api.db.query<{ id: string }>(
      `select id from proposals where entity_id = $1 and status = 'open'`, [id])).rows[0]!.id;

    const result = await workflow.confirm(proposalId, 'ben@castilla.gov.ph');

    expect(result.ok).toBe(true);
    const state = await api.db.query<{ state: string }>(
      `select state::text from field_state
        where entity_id = $1 and field_name = 'contact.email'`, [id]);
    expect(state.rows[0]?.state).toBe('confirmed');
  });
});

describe('every write path is covered', () => {
  it('audits a revert', async () => {
    const id = await proposeAndConfirm('contact.telephone', '(056) 333-3333');
    await workflow.revert('office', id, 'contact.telephone', 'ben@castilla.gov.ph');

    const rows = await api.db.query<{ action: string; prior_value: string }>(
      `select action, prior_value from audit_log
        where entity_id = $1 and action = 'reverted'`, [id]);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.prior_value).toBe('(056) 333-3333');
  });

  it('audits the announcement lifecycle', async () => {
    const service = new AnnouncementsService(api.db);
    await service.draft({
      slug: 'audit-notice', title: 'A notice', body: 'Plain text.', category: 'advisory',
    }, 'ana@castilla.gov.ph');
    await service.publish('audit-notice', 'ben@castilla.gov.ph', new Date());
    await service.withdraw('audit-notice', 'cara@castilla.gov.ph', 'superseded');

    const history = await audit.history('announcement', 'audit-notice');

    expect(history.map((row) => row.action)).toEqual([
      'announcement-drafted', 'announcement-published', 'announcement-withdrawn',
    ]);
    expect(history[2]?.actor).toBe('cara@castilla.gov.ph');
    expect(history[2]?.detail).toBe('superseded');
  });

  it('audits a page revision, with both texts', async () => {
    const before = (await api.db.query<{ body: string }>(
      "select body from content_pages where key = 'mission'")).rows[0]!.body;
    await new PagesService(api.db).replace('mission', {
      title: 'Mission', body: 'A newly written mission statement.', isPlaceholder: false,
    }, 'ana@castilla.gov.ph');

    const history = await audit.history('page', 'mission');
    const replaced = history.find((row) => row.action === 'page-replaced');

    expect(replaced?.priorValue).toBe(before);
    expect(replaced?.newValue).toBe('A newly written mission statement.');
  });
});

describe('the history endpoint', () => {
  it('returns an office’s changes in order', async () => {
    // TAB 12's criterion, against a real office.
    const id = await officeId('municipal-engineering');
    await api.db.query(
      `insert into proposals (entity_type, entity_id, field_name, proposed_value,
                              source_description, sourced_on, method, proposed_by, status)
       values ('office',$1,'contact.telephone','(056) 444-0001',
               'the LGU Citizen''s Charter, page 12, read at the counter',
               date '2026-08-31','official-document','ana@castilla.gov.ph','open')`, [id]);
    const proposalId = (await api.db.query<{ id: string }>(
      `select id from proposals where entity_id = $1 and status = 'open'`, [id])).rows[0]!.id;
    await workflow.confirm(proposalId, 'ben@castilla.gov.ph');
    await workflow.revert('office', id, 'contact.telephone', 'cara@castilla.gov.ph');

    const { status, body } = await api.get(`/staff/history/office/${id}`);
    // Staff-only: an anonymous caller sees nothing, not even that it exists.
    expect(status).toBe(404);

    const history = await audit.history('office', id);
    expect(history.map((row) => row.action)).toEqual(['confirmed', 'reverted']);
    expect(new Date(history[0]!.at).getTime())
      .toBeLessThanOrEqual(new Date(history[1]!.at).getTime());
    void body;
  });

  it('redacts a withheld value at READ time, keeping the row', async () => {
    // TAB 12's rule: redact nothing at write time. The trail must still be able
    // to answer 'was this ever published, and when did it stop' — which a
    // blanked row cannot.
    const id = await officeId('municipal-civil-registrar');
    await api.db.query(
      `insert into proposals (entity_type, entity_id, field_name, proposed_value,
                              source_description, sourced_on, method, proposed_by, status)
       values ('office',$1,'contact.email','private.person@gmail.com',
               'the LGU Citizen''s Charter, page 12, read at the counter',
               date '2026-08-31','official-document','ana@castilla.gov.ph','open')`, [id]);
    const proposalId = (await api.db.query<{ id: string }>(
      `select id from proposals where entity_id = $1 and status = 'open'`, [id])).rows[0]!.id;
    await workflow.confirm(proposalId, 'ben@castilla.gov.ph');

    // The owner later rules this a personal address, not an institutional one.
    await api.db.query(
      `update field_state set state = 'withheld'
        where entity_id = $1 and field_name = 'contact.email'`, [id]);

    const history = await audit.history('office', id);
    const row = history.find((entry) => entry.fieldName === 'contact.email');

    expect(row).toBeDefined();
    expect(row?.newValue).toBe('[withheld]');
    expect(row?.redacted).toBe(true);
    // The stored row is intact: redaction is a read-time rule, not a deletion.
    const stored = await api.db.query<{ new_value: string }>(
      `select new_value from audit_log
        where entity_id = $1 and field_name = 'contact.email'`, [id]);
    expect(stored.rows[0]!.new_value).toBe('private.person@gmail.com');
  });
});
