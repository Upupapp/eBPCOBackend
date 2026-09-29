import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { holdsSuperAdmin } from '../../identity/application/super-admin-guard';
import { IN_PROGRESS_STATUSES } from '../../businesses/in-progress-statuses';
import { Caller } from '../domain/application';

/**
 * Everything that has been set aside, in one place, and the way back for each
 * (owner request, 2026-09-29: "all accounts, even the super admin, can only
 * archive things ... redesign the archive screen so that it can cater to all
 * things that will be archived").
 *
 * Archiving never deletes. Each kind keeps the columns it already had where it
 * had them -- `applications.archived_at` (018), `accounts.removed_at` (057),
 * `permit_types.retired_at` (032) -- and 062 added them where there were none.
 * This service reads them all as one list, archives the kinds that had no
 * route (citizens, businesses), and restores every kind.
 */

export type ArchiveKind = 'application' | 'staff' | 'citizen' | 'business' | 'requirement' | 'permit-type';

export const ARCHIVE_KINDS: readonly ArchiveKind[] = [
  'application', 'staff', 'citizen', 'business', 'requirement', 'permit-type',
];

export interface ArchivedItem {
  readonly kind: ArchiveKind;
  /** The id a restore names: a UUID, or for a permit type its name. */
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly archivedAt: string | null;
  readonly archivedBy: string | null;
  readonly reason: string | null;
  /** Whether the officer asking may restore it. */
  readonly canRestore: boolean;
}

export type ArchiveOutcome =
  | { readonly ok: true; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-permitted' | 'in-progress' | 'already' | 'erased' | 'reason-required';
      readonly detail: string;
    };

const WHO = `coalesce(nullif(trim(by_account.full_name), ''), by_account.email)`;
/** Statuses an office still owes work on. A Draft is the citizen's own, not the office's. */
const OFFICE_WORK = IN_PROGRESS_STATUSES.filter((status) => status !== 'Draft');

export class ArchiveService {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly audit: AuditService = new AuditService(db, clock),
  ) {}

  /** Who may restore (and archive) each kind. The server's answer, which the portal only mirrors. */
  private async mayHandle(caller: Caller, kind: ArchiveKind): Promise<boolean> {
    if (caller.kind !== 'staff') return false;
    if (await holdsSuperAdmin(this.db, caller.accountId)) return true;
    const holds = (scope: string): boolean => caller.scopes.includes(scope);
    switch (kind) {
      case 'application': return holds('applications:write');
      case 'business': return holds('applications:write') || holds('staff:administer');
      case 'citizen': return holds('staff:administer');
      case 'requirement': return holds('staff:administer');
      // Staff accounts and permit types: the super admin's alone, as removing
      // one and retiring the other already were.
      case 'staff': return false;
      case 'permit-type': return false;
    }
  }

  async list(caller: Caller): Promise<readonly ArchivedItem[]> {
    const may = new Map<ArchiveKind, boolean>();
    for (const kind of ARCHIVE_KINDS) may.set(kind, await this.mayHandle(caller, kind));
    const items: ArchivedItem[] = [];
    const when = (value: Date | null): string | null => (value === null ? null : value.toISOString());

    const applications = await this.db.query<{
      id: string; reference_number: string; permit_type: string; lifecycle_status: string; applicant: string | null;
      archived_at: Date | null; archive_remarks: string | null; by_name: string | null;
    }>(
      `select a.id, a.reference_number, a.permit_type, a.lifecycle_status, a.archived_at, a.archive_remarks,
              trim(concat_ws(' ', ap.first_name, ap.last_name)) as applicant, ${WHO} as by_name
         from applications a
         left join applicants ap on ap.id = a.applicant_id
         left join accounts by_account on by_account.id = a.archived_by
        where a.archived_at is not null order by a.archived_at desc`,
    );
    for (const row of applications.rows) {
      items.push({
        kind: 'application', id: row.id, title: row.reference_number,
        subtitle: [row.permit_type, row.applicant, row.lifecycle_status].filter(Boolean).join(' · '),
        archivedAt: when(row.archived_at), archivedBy: row.by_name, reason: row.archive_remarks,
        canRestore: may.get('application')!,
      });
    }

    const accounts = await this.db.query<{
      id: string; kind: 'staff' | 'applicant'; email: string; full_name: string | null; citizen: string | null;
      roles: string[] | null; removed_at: Date | null; removed_reason: string | null; by_name: string | null;
    }>(
      `select a.id, a.kind, a.email, a.full_name, a.removed_at, a.removed_reason,
              trim(concat_ws(' ', ap.first_name, ap.last_name)) as citizen,
              array(select r.role from account_roles r where r.account_id = a.id) as roles,
              ${WHO} as by_name
         from accounts a
         left join applicants ap on ap.account_id = a.id
         left join accounts by_account on by_account.id = a.removed_by
        where a.removed_at is not null and a.erased_at is null
        order by a.removed_at desc`,
    );
    for (const row of accounts.rows) {
      const staff = row.kind === 'staff';
      items.push({
        kind: staff ? 'staff' : 'citizen', id: row.id,
        title: (staff ? row.full_name : row.citizen)?.trim() || row.email,
        subtitle: staff ? [row.email, ...(row.roles ?? [])].join(' · ') : row.email,
        archivedAt: when(row.removed_at), archivedBy: row.by_name, reason: row.removed_reason,
        canRestore: may.get(staff ? 'staff' : 'citizen')!,
      });
    }

    const businesses = await this.db.query<{
      id: string; name: string; registration_number: string | null; owner: string | null;
      archived_at: Date | null; archive_reason: string | null; by_name: string | null;
    }>(
      `select b.id, b.name, b.registration_number, b.archived_at, b.archive_reason,
              trim(concat_ws(' ', ap.first_name, ap.last_name)) as owner, ${WHO} as by_name
         from businesses b
         left join applicants ap on ap.id = b.owner_applicant_id
         left join accounts by_account on by_account.id = b.archived_by
        where b.archived_at is not null order by b.archived_at desc`,
    );
    for (const row of businesses.rows) {
      items.push({
        kind: 'business', id: row.id, title: row.name,
        subtitle: [row.registration_number, row.owner].filter(Boolean).join(' · '),
        archivedAt: when(row.archived_at), archivedBy: row.by_name, reason: row.archive_reason,
        canRestore: may.get('business')!,
      });
    }

    const requirements = await this.db.query<{
      id: string; label: string; permit_type: string; application_action: string | null;
      archived_at: Date | null; by_name: string | null;
    }>(
      `select d.id, d.label, d.permit_type, d.application_action, d.archived_at, ${WHO} as by_name
         from document_requirements d
         left join accounts by_account on by_account.id = d.archived_by
        where d.archived_at is not null order by d.archived_at desc`,
    );
    for (const row of requirements.rows) {
      items.push({
        kind: 'requirement', id: row.id, title: row.label,
        subtitle: `Checklist: ${row.permit_type}${row.application_action ? ` (${row.application_action})` : ''}`,
        archivedAt: when(row.archived_at), archivedBy: row.by_name, reason: null,
        canRestore: may.get('requirement')!,
      });
    }

    const permitTypes = await this.db.query<{ permit_type: string; retired_at: Date | null; by_name: string | null }>(
      `select p.permit_type, p.retired_at, ${WHO} as by_name
         from permit_types p
         left join accounts by_account on by_account.id = p.retired_by
        where p.retired_at is not null order by p.retired_at desc`,
    );
    for (const row of permitTypes.rows) {
      items.push({
        kind: 'permit-type', id: row.permit_type, title: row.permit_type,
        subtitle: 'Permit type — no longer offered for filing',
        archivedAt: when(row.retired_at), archivedBy: row.by_name,
        reason: row.permit_type.includes('(BFP)')
          ? 'Issued by the Bureau of Fire Protection through BFP-FSIS, not by the Municipality.'
          : null,
        canRestore: may.get('permit-type')!,
      });
    }

    return items;
  }

  /** Archives a citizen account or a business -- the two kinds that had no archive route. */
  async archive(options: {
    caller: Caller; kind: 'citizen' | 'business'; id: string; reason: string;
  }): Promise<ArchiveOutcome> {
    const { caller, kind, id } = options;
    const reason = options.reason.trim();
    if (reason === '') return { ok: false, reason: 'reason-required', detail: 'Say why it is being archived.' };
    if (!(await this.mayHandle(caller, kind))) {
      return { ok: false, reason: 'not-permitted', detail: `Your position cannot archive a ${noun(kind)}.` };
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, reason: 'not-found', detail: `No such ${noun(kind)}.` };
    const now = this.clock();

    if (kind === 'citizen') {
      const found = await this.db.query<{ removed_at: Date | null; erased_at: Date | null; open: number }>(
        `select a.removed_at, a.erased_at,
                (select count(*)::int from applications x join applicants ap on ap.id = x.applicant_id
                  where ap.account_id = a.id and x.lifecycle_status = any($2)) as open
           from accounts a where a.id = $1 and a.kind = 'applicant'`,
        [id, OFFICE_WORK],
      );
      const row = found.rows[0];
      if (row === undefined) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };
      if (row.erased_at !== null) return { ok: false, reason: 'erased', detail: 'This account was erased at the citizen’s request.' };
      if (row.removed_at !== null) return { ok: false, reason: 'already', detail: 'This account is already archived.' };
      if (row.open > 0) {
        return {
          ok: false, reason: 'in-progress',
          detail: `This citizen has ${row.open} application${row.open === 1 ? '' : 's'} still being processed. `
            + 'Archive the account once they are decided.',
        };
      }
      await this.db.transaction(async (tx) => {
        await tx.query(
          `update accounts set disabled_at = coalesce(disabled_at, $2), removed_at = $2, removed_by = $3,
                  removed_reason = $4, updated_at = $2
            where id = $1`,
          [id, now, caller.accountId, reason],
        );
        await this.audit.append(entry('citizen.archived', 'account', id, caller, { reason }), tx);
      });
      return { ok: true, detail: 'Citizen account archived. They cannot sign in until it is restored.' };
    }

    const found = await this.db.query<{ archived_at: Date | null; open: number }>(
      `select b.archived_at,
              (select count(*)::int from applications x where x.business_id = b.id and x.lifecycle_status = any($2)) as open
         from businesses b where b.id = $1`,
      [id, OFFICE_WORK],
    );
    const row = found.rows[0];
    if (row === undefined) return { ok: false, reason: 'not-found', detail: 'No such business.' };
    if (row.archived_at !== null) return { ok: false, reason: 'already', detail: 'This business is already archived.' };
    if (row.open > 0) {
      return {
        ok: false, reason: 'in-progress',
        detail: 'This business has an application still being processed. Archive it once that is decided.',
      };
    }
    await this.db.transaction(async (tx) => {
      await tx.query(
        'update businesses set archived_at = $2, archived_by = $3, archive_reason = $4, updated_at = $2 where id = $1',
        [id, now, caller.accountId, reason],
      );
      await this.audit.append(entry('business.archived', 'business', id, caller, { reason }), tx);
    });
    return { ok: true, detail: 'Business archived. It is out of the Businesses list until it is restored.' };
  }

  /** Brings an archived item back to where it was. */
  async restore(options: { caller: Caller; kind: ArchiveKind; id: string }): Promise<ArchiveOutcome> {
    const { caller, kind, id } = options;
    if (!(await this.mayHandle(caller, kind))) {
      return {
        ok: false, reason: 'not-permitted',
        detail: kind === 'staff' || kind === 'permit-type'
          ? `Only a super admin can restore a ${noun(kind)}.`
          : `Your position cannot restore a ${noun(kind)}.`,
      };
    }
    const now = this.clock();
    const restored = await this.db.transaction(async (tx) => {
      let changed = 0;
      switch (kind) {
        case 'application':
          changed = (await tx.query(
            `update applications set archived_at = null, archived_by = null, archive_remarks = null,
                    updated_at = $2, updated_by = $3
              where id::text = $1 and archived_at is not null returning id`,
            [id, now, caller.accountId],
          )).rows.length;
          break;
        case 'staff':
        case 'citizen':
          changed = (await tx.query(
            `update accounts set removed_at = null, removed_by = null, removed_reason = null,
                    disabled_at = null, updated_at = $2
              where id::text = $1 and kind = $3 and removed_at is not null and erased_at is null returning id`,
            [id, now, kind === 'staff' ? 'staff' : 'applicant'],
          )).rows.length;
          break;
        case 'business':
          changed = (await tx.query(
            `update businesses set archived_at = null, archived_by = null, archive_reason = null, updated_at = $2
              where id::text = $1 and archived_at is not null returning id`,
            [id, now],
          )).rows.length;
          break;
        case 'requirement':
          // Back at the end of its checklist: where it was is taken by now.
          changed = (await tx.query(
            `update document_requirements d
                set archived_at = null, archived_by = null, updated_at = $2, updated_by = $3,
                    position = coalesce((select max(x.position) + 1 from document_requirements x
                                          where x.permit_type = d.permit_type
                                            and x.application_action is not distinct from d.application_action
                                            and x.archived_at is null), 0)
              where d.id::text = $1 and d.archived_at is not null returning d.id`,
            [id, now, caller.accountId],
          )).rows.length;
          break;
        case 'permit-type':
          changed = (await tx.query(
            `update permit_types set retired_at = null, retired_by = null
              where permit_type = $1 and retired_at is not null returning permit_type`,
            [id],
          )).rows.length;
          break;
      }
      if (changed > 0) {
        // A checklist document or a permit type is configuration, audited the
        // way `requirements.replaced` is: no subject row, the thing named.
        const configuration = kind === 'requirement' || kind === 'permit-type';
        await this.audit.append(
          entry(`${kind}.restored`, subjectOf(kind), configuration ? null : id, caller, configuration ? { [kind]: id } : {}),
          tx,
        );
      }
      return changed > 0;
    });
    if (!restored) return { ok: false, reason: 'not-found', detail: `That ${noun(kind)} is not in the archive.` };
    return { ok: true, detail: RESTORED[kind] };
  }
}

const RESTORED: Readonly<Record<ArchiveKind, string>> = {
  application: 'Application restored to the working list.',
  staff: 'Staff account restored and enabled. The officer can sign in again.',
  citizen: 'Citizen account restored. They can sign in again.',
  business: 'Business restored to the Businesses list.',
  requirement: 'Document restored to the end of its checklist.',
  'permit-type': 'Permit type restored: citizens can file it again.',
};

function noun(kind: ArchiveKind): string {
  switch (kind) {
    case 'application': return 'application';
    case 'staff': return 'staff account';
    case 'citizen': return 'citizen account';
    case 'business': return 'business';
    case 'requirement': return 'checklist document';
    case 'permit-type': return 'permit type';
  }
}

function subjectOf(kind: ArchiveKind): 'application' | 'account' | 'business' {
  if (kind === 'staff' || kind === 'citizen') return 'account';
  if (kind === 'business') return 'business';
  return 'application';
}

function entry(
  action: string, subjectType: 'application' | 'account' | 'business', subjectId: string | null,
  caller: Caller, afterState: Record<string, unknown>,
) {
  return {
    action, subjectType, subjectId, outcome: 'allowed' as const,
    actorAccountId: caller.accountId, actorRole: caller.kind, afterState,
  };
}
