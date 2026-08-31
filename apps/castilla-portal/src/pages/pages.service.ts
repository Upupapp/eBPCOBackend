import { Inject, Injectable } from '@nestjs/common';

import { audit } from '../audit/audit';
import { inTransaction } from '../persistence/transaction';
import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface PageEdit {
  readonly title: string;
  readonly body: string;
  readonly isPlaceholder: boolean;
}

export type EditResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Replacing a page's text, keeping what it said before.
 *
 * NOT exposed over HTTP — staff authentication is TAB 11, and the same argument
 * as the announcements lifecycle applies: an unauthenticated route that rewrites
 * a municipality's privacy policy is not a feature awaiting a guard.
 */
@Injectable()
export class PagesService {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  async replace(key: string, edit: PageEdit, author: string): Promise<EditResult> {
    if (author.trim() === '') return { ok: false, reason: 'author-required' };
    if (edit.body.trim() === '') return { ok: false, reason: 'body-required' };

    const { rows } = await this.db.query<{
      title: string; body: string; is_placeholder: boolean;
    }>('select title, body, is_placeholder from content_pages where key = $1', [key]);
    const current = rows[0];
    if (current === undefined) return { ok: false, reason: 'no-such-page' };

    await inTransaction(this.db, async (tx) => {
      // The prior text is archived BEFORE the update, so an interruption
      // between the two statements loses the edit rather than the history —
      // and the transaction means neither happens alone.
      await tx.query(
        `insert into content_page_revisions (key, title, body, is_placeholder, author)
         values ($1,$2,$3,$4,$5)`,
        [key, current.title, current.body, current.is_placeholder, author],
      );
      await tx.query(
        `update content_pages
            set title = $2, body = $3, is_placeholder = $4, updated_at = now()
          where key = $1`,
        [key, edit.title, edit.body, edit.isPlaceholder],
      );

      // Replacing the text invalidates whatever sourcing the old text had. The
      // page returns to pending until someone confirms the NEW words, which is
      // the same rule the seeder follows: never auto-confirm.
      await tx.query(
        `update field_state set state = 'pending', updated_at = now()
          where entity_type = 'page' and entity_id = $1 and field_name = 'body'`, [key]);

      await audit(tx, {
        actor: author, action: 'page-replaced', entityType: 'page', entityId: key,
        fieldName: 'body', priorValue: current.body, newValue: edit.body,
        detail: 'returned to pending: the new words are unsourced',
      });
    });

    return { ok: true };
  }
}
