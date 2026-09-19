import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';

/**
 * Internal staff notes on an application — a workspace for the office to
 * leave each other context that is neither a lifecycle transition nor an
 * applicant-facing remark (e.g. an evaluator flagging something for the
 * assessor before handing the file on).
 *
 * `authorEmail` is joined at read time rather than stored on the row: a
 * staff account has no name column at all (the email stands in, the same
 * convention `staff-directory` already uses), and joining means a later
 * email change is reflected on every past note instead of freezing
 * whatever address was current when it was written.
 */

export interface ApplicationNote {
  readonly id: string;
  readonly applicationId: string;
  readonly authorAccountId: string;
  readonly authorEmail: string;
  readonly parentNoteId: string | null;
  readonly depth: 0 | 1 | 2;
  readonly body: string;
  readonly createdAt: string;
}

export type CreateNoteResult =
  | { readonly ok: true; readonly note: ApplicationNote }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const ROW_SELECT = `
  select n.id, n.application_id, n.author_account_id, acc.email as author_email,
         n.parent_note_id, n.depth, n.body, n.created_at
    from application_notes n
    join accounts acc on acc.id = n.author_account_id
`;

interface NoteRow {
  id: string;
  application_id: string;
  author_account_id: string;
  author_email: string;
  parent_note_id: string | null;
  depth: number;
  body: string;
  created_at: string;
}

function toNote(row: NoteRow): ApplicationNote {
  return {
    id: row.id,
    applicationId: row.application_id,
    authorAccountId: row.author_account_id,
    authorEmail: row.author_email,
    parentNoteId: row.parent_note_id,
    depth: row.depth as 0 | 1 | 2,
    body: row.body,
    createdAt: row.created_at,
  };
}

export class NotesService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /** Oldest first — a conversation thread, not a feed. */
  async listFor(applicationId: string): Promise<readonly ApplicationNote[]> {
    const result = await this.db.query<NoteRow>(
      `${ROW_SELECT} where n.application_id = $1 order by n.created_at asc`,
      [applicationId],
    );
    return result.rows.map(toNote);
  }

  /**
   * `parentNoteId`'s own depth decides this note's depth — the client already
   * caps a reply at two levels of nesting; this just carries that decision
   * into the row rather than trusting a depth the client sends directly.
   */
  async create(options: {
    applicationId: string;
    body: string;
    parentNoteId: string | null;
    caller: Caller;
  }): Promise<CreateNoteResult> {
    const { applicationId, parentNoteId, caller } = options;
    const body = options.body.trim();
    if (body.length === 0) {
      return { ok: false, reason: 'empty', detail: 'A note cannot be empty.' };
    }

    return this.db.transaction(async (tx) => {
      let depth: 0 | 1 | 2 = 0;
      if (parentNoteId !== null) {
        const parent = await tx.query<{ depth: number; application_id: string }>(
          'select depth, application_id from application_notes where id = $1',
          [parentNoteId],
        );
        const row = parent.rows[0];
        if (row === undefined || row.application_id !== applicationId) {
          return {
            ok: false, reason: 'no-such-parent',
            detail: 'That note no longer exists on this application.',
          };
        }
        depth = Math.min(row.depth + 1, 2) as 0 | 1 | 2;
      }

      const inserted = await tx.query<{ id: string }>(
        `insert into application_notes (application_id, author_account_id, parent_note_id, depth, body)
         values ($1,$2,$3,$4,$5) returning id`,
        [applicationId, caller.accountId, parentNoteId, depth, body],
      );
      const id = inserted.rows[0]?.id ?? '';

      await this.audit.append({
        action: 'application.note-added',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: caller.kind,
        afterState: { noteId: id, parentNoteId, depth },
      }, tx);

      const created = await tx.query<NoteRow>(`${ROW_SELECT} where n.id = $1`, [id]);
      const row = created.rows[0];
      if (row === undefined) {
        return { ok: false, reason: 'insert-failed', detail: 'The note could not be saved.' };
      }
      return { ok: true, note: toNote(row) };
    });
  }
}
