import { Inject, Injectable } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';

export interface DraftAnnouncement {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly attachmentFormId?: string;
}

export type LifecycleResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The announcement lifecycle: draft, publish (or schedule), withdraw.
 *
 * NOT exposed over HTTP in this TAB, and that is deliberate. Staff
 * authentication is TAB 11, and an unauthenticated POST that publishes to a
 * municipal government's homepage is not a feature waiting for a guard — it is
 * the guard's absence with a route attached. The lifecycle is built and tested
 * here so TAB 11 supplies an identity rather than a domain.
 *
 * Every method takes an `actor`. There is no default and no 'system': the
 * database refuses a withdrawal with no event naming who did it, and this is
 * the layer that makes sure there is a name to give it.
 */
@Injectable()
export class AnnouncementsService {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  async draft(input: DraftAnnouncement, actor: string): Promise<LifecycleResult> {
    if (actor.trim() === '') return { ok: false, reason: 'actor-required' };
    // Refused here as well as by the schema, so an editor gets a sentence
    // rather than a constraint violation.
    if (/<[A-Za-z/!?]/.test(input.body)) return { ok: false, reason: 'body-must-be-plain-text' };

    const { rows } = await this.db.query<{ id: string }>(
      `insert into announcements (slug, title, body, category, attachment_form_id)
       values ($1,$2,$3,$4,$5)
       on conflict (slug) do nothing
       returning id`,
      [input.slug, input.title, input.body, input.category, input.attachmentFormId ?? null],
    );
    const id = rows[0]?.id;
    if (id === undefined) return { ok: false, reason: 'slug-already-used' };

    await this.record(id, 'created', actor, null);
    return { ok: true, id };
  }

  /**
   * Publish, or schedule by passing a future moment.
   *
   * One method rather than two, because they are the same act: a publication
   * time in the future is a schedule, and the read queries already compare that
   * time to the clock. Nothing has to run at the appointed minute.
   */
  async publish(slug: string, actor: string, at: Date, expiresAt?: Date): Promise<LifecycleResult> {
    if (actor.trim() === '') return { ok: false, reason: 'actor-required' };
    if (expiresAt !== undefined && expiresAt.getTime() <= at.getTime()) {
      return { ok: false, reason: 'expiry-must-follow-publication' };
    }

    const { rows } = await this.db.query<{ id: string }>(
      `update announcements
          set status = 'published', published_at = $2, expires_at = $3, updated_at = now()
        where slug = $1 and status <> 'withdrawn'
        returning id`,
      [slug, at, expiresAt ?? null],
    );
    const id = rows[0]?.id;
    // A withdrawn announcement is not re-published by the same call that
    // publishes a draft. Bringing something back is a decision of its own.
    if (id === undefined) return { ok: false, reason: 'not-found-or-withdrawn' };

    await this.record(id, 'published', actor, null);
    return { ok: true, id };
  }

  /**
   * Withdraw: stops being served, is never deleted.
   *
   * The event is written BEFORE the status changes, because the deferred
   * trigger checks at commit and the whole point is that a withdrawal without
   * an attributable event cannot exist — not even briefly, and not if this
   * method is interrupted between statements.
   */
  async withdraw(slug: string, actor: string, reason?: string): Promise<LifecycleResult> {
    if (actor.trim() === '') return { ok: false, reason: 'actor-required' };

    const { rows } = await this.db.query<{ id: string }>(
      "select id from announcements where slug = $1 and status <> 'withdrawn'", [slug]);
    const id = rows[0]?.id;
    if (id === undefined) return { ok: false, reason: 'not-found-or-already-withdrawn' };

    await this.record(id, 'withdrawn', actor, reason ?? null);
    await this.db.query(
      "update announcements set status = 'withdrawn', updated_at = now() where id = $1", [id]);
    return { ok: true, id };
  }

  /** The audit trail for one announcement, oldest first. */
  async history(slug: string): Promise<{ action: string; actor: string; reason: string | null }[]> {
    const { rows } = await this.db.query<{ action: string; actor: string; reason: string | null }>(
      `select e.action, e.actor, e.reason from announcement_events e
         join announcements a on a.id = e.announcement_id
        where a.slug = $1 order by e.at, e.action`, [slug]);
    return rows;
  }

  private async record(
    id: string, action: string, actor: string, reason: string | null,
  ): Promise<void> {
    await this.db.query(
      `insert into announcement_events (announcement_id, action, actor, reason)
       values ($1,$2,$3,$4)`,
      [id, action, actor, reason],
    );
  }
}
