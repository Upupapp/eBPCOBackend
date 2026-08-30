import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';

/**
 * An applicant answering a Letter of Instruction.
 *
 * Resolving an item means the applicant has RESPONDED to it, not that the
 * officer accepted the response. The officer's re-evaluation is the check —
 * conflating the two would let an officer's own backlog block an applicant from
 * replying, which is the opposite of what RA 11032 is for: the pledge clock is
 * suspended while the applicant holds the application, and it cannot restart
 * until they can hand it back.
 */

export type RespondResult =
  | { readonly ok: true; readonly resolved: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'nothing-open' | 'unknown-item'; readonly detail: string };

export class InstructionResponseService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async respond(options: {
    applicationId: string;
    letterId: string;
    caller: Caller;
    responses: ReadonlyArray<{ itemId: string; response: string; documentId?: string | null | undefined }>;
  }): Promise<RespondResult> {
    const { applicationId, letterId, caller, responses } = options;

    return this.db.transaction(async (tx) => {
      const letter = await tx.query<{ id: string }>(
        'select id from letters_of_instruction where id = $1 and application_id = $2',
        [letterId, applicationId],
      );
      if (letter.rows.length === 0) {
        // A letter belonging to a different application answers the same as one
        // that does not exist.
        return { ok: false, reason: 'not-found', detail: 'No such Letter of Instruction.' };
      }

      const open = await tx.query<{ id: string }>(
        'select id from instruction_items where letter_id = $1 and resolved_at is null for update',
        [letterId],
      );
      if (open.rows.length === 0) {
        return {
          ok: false, reason: 'nothing-open',
          detail: 'Every item on this Letter of Instruction has already been answered.',
        };
      }

      const openIds = new Set(open.rows.map((row) => row.id));
      const unknown = responses.filter((response) => !openIds.has(response.itemId));
      if (unknown.length > 0) {
        // Refused rather than ignored. An applicant who wrote an explanation
        // against the wrong item has not answered the one they meant to, and
        // silently dropping the text loses work they did.
        return {
          ok: false, reason: 'unknown-item',
          detail: 'One or more responses refer to an item that is not open on this letter.',
        };
      }

      const now = this.clock();
      for (const response of responses) {
        await tx.query(
          `update instruction_items
              set response = $2, response_document_id = $3, resolved_at = $4
            where id = $1`,
          [response.itemId, response.response, response.documentId ?? null, now],
        );
      }

      // Everything else on the letter is resolved with no text. Resubmitting IS
      // the response: at a counter an applicant hands back the corrected papers
      // rather than annotating each line of the officer's note.
      const remaining = await tx.query(
        'update instruction_items set resolved_at = $2 where letter_id = $1 and resolved_at is null',
        [letterId, now],
      );

      await tx.query(
        'update letters_of_instruction set closed_at = $2 where id = $1 and closed_at is null',
        [letterId, now],
      );

      await this.audit.append({
        action: 'instruction.responded',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        afterState: { letterId, itemsAnswered: responses.length, itemsResolved: open.rows.length },
      }, tx);

      return { ok: true, resolved: responses.length + remaining.rowCount };
    });
  }
}
