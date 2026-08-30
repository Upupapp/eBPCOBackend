import { SqlClient } from '../../../persistence/sql-client';
import { StaffRole } from '../../identity/domain/account';
import { LifecycleStatus, TransitionRule } from '../../applications/domain/lifecycle';
import { StaffNotice, awaitingYou } from '../domain/staff-catalog';
import { recipientsFor, recipientsWhenApplicantStalls } from '../domain/staff-recipients';

/**
 * Writing to an officer's worklist. TAB 14, owner decision D-7.
 *
 * Every write here takes the CALLER'S transaction. A notice that an application
 * is waiting, committed for a transition that then rolled back, sends an officer
 * to an application that is not where they were told it is — and the reverse,
 * a transition committed with the notice lost, leaves a queue nobody knows
 * about. The applicant pipeline settled this the same way.
 */

export interface StaffNotificationRow {
  readonly id: string;
  readonly type: string;
  readonly applicationId: string | null;
  readonly routedToRole: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export class StaffNotificationService {
  constructor(
    private readonly db: SqlClient,
    /**
     * Called when a notice was routed to real roles and reached NO account.
     *
     * That is not a rare edge: an LGU that has not created a receiving officer,
     * or whose only one is disabled, gets applications arriving in a queue
     * nobody is told about. Nothing else in the system would say so -- the
     * transition succeeds, the routing is correct, and the inbox is simply
     * empty. Surfaced rather than counted, because a count nobody reads is the
     * same as no count.
     */
    private readonly onNobodyToTell:
      (status: string, roles: readonly string[]) => void = () => undefined,
  ) {}

  /**
   * Tells whoever is now waiting on this application that it is waiting.
   *
   * Called after a status change, with the rules the change was decided under —
   * passed in rather than re-read, so the notice and the transition cannot
   * disagree about what the workflow said at that moment.
   */
  async announceArrival(options: {
    tx: SqlClient;
    applicationId: string;
    reference: string;
    status: LifecycleStatus;
    rules: readonly TransitionRule[];
    /** The officer who made the move: never told about their own act. */
    actingAccountId: string | null;
  }): Promise<number> {
    const { tx, applicationId, reference, status, rules, actingAccountId } = options;

    const decision = recipientsFor(status, rules);
    if (decision.roles.length === 0) return 0;

    const notice = awaitingYou(reference, status, applicationId);
    let written = 0;
    for (const role of decision.roles) {
      written += await this.writeTo(tx, role, notice, applicationId, actingAccountId);
    }

    // Zero is not automatically wrong -- the only holder may be the officer who
    // just made the move, and not telling them is deliberate. It is wrong when
    // the role has no enabled account at all, which is the case worth naming.
    if (written === 0 && !await this.anyoneHolds(tx, decision.roles)) {
      this.onNobodyToTell(status, decision.roles);
    }
    return written;
  }

  /**
   * Tells whoever must now decide, because the applicant has stopped.
   *
   * Routed by `recipientsWhenApplicantStalls` rather than `recipientsFor`: at
   * `Assessed` nobody is waiting in the ordinary course, and that is exactly
   * the status an overdue Order sits in.
   */
  async announceStall(options: {
    tx: SqlClient;
    applicationId: string;
    status: LifecycleStatus;
    rules: readonly TransitionRule[];
    notice: StaffNotice;
  }): Promise<number> {
    const decision = recipientsWhenApplicantStalls(options.status, options.rules);
    if (decision.roles.length === 0) {
      this.onNobodyToTell(options.status, decision.roles);
      return 0;
    }

    let written = 0;
    for (const role of decision.roles) {
      // No actor to exclude: a scheduled sweep is not an officer, and there is
      // nobody who already knows.
      written += await this.writeTo(options.tx, role, options.notice, options.applicationId, null);
    }
    if (written === 0 && !await this.anyoneHolds(options.tx, decision.roles)) {
      this.onNobodyToTell(options.status, decision.roles);
    }
    return written;
  }

  /**
   * A notice to every member of staff, addressed to nobody's queue in particular.
   *
   * One statement over accounts rather than a loop over roles: an officer who
   * holds two roles is one person, and looping would tell them twice. The
   * unique index cannot catch that, because it only covers notices about an
   * application and this kind has none.
   */
  async announceToAll(
    tx: SqlClient, notice: StaffNotice, exceptAccountId: string | null,
  ): Promise<number> {
    const result = await tx.query<{ id: string }>(
      `insert into staff_notifications
         (account_id, type, application_id, routed_to_role, title, body, deep_link)
       select distinct a.id, $1, null::uuid, 'all', $2, $3, $4
         from accounts a
        where a.kind = 'staff'
          and a.disabled_at is null
          and ($5::uuid is null or a.id <> $5)
       returning id`,
      [notice.type, notice.title, notice.body, notice.deepLink, exceptAccountId],
    );
    return result.rows.length;
  }

  /**
   * Whether ANY enabled staff account holds one of these roles -- the actor
   * included, deliberately.
   *
   * The question is "is there an officer for this work", not "was anyone
   * notified". An office with one receiving officer who has just moved the
   * application has an officer; they were not told because they already know.
   * Excluding the actor here made every such move warn, which would have
   * trained an operator to ignore the one warning that means an application is
   * stuck in a queue with nobody to work it.
   */
  private async anyoneHolds(tx: SqlClient, roles: readonly string[]): Promise<boolean> {
    const held = await tx.query<{ one: number }>(
      `select 1 as one from accounts a
         join account_roles r on r.account_id = a.id
        where r.role = any($1) and a.kind = 'staff' and a.disabled_at is null
        limit 1`,
      [[...roles]],
    );
    return held.rows.length > 0;
  }

  private async writeTo(
    tx: SqlClient, role: StaffRole, notice: StaffNotice,
    applicationId: string | null, exceptAccountId: string | null,
  ): Promise<number> {
    const result = await tx.query<{ id: string }>(
      `insert into staff_notifications
         (account_id, type, application_id, routed_to_role, title, body, deep_link)
       select a.id, $1, $2, $3, $4, $5, $6
         from accounts a
         join account_roles r on r.account_id = a.id
        where r.role = $7
          and a.kind = 'staff'
          -- Disabled and erased accounts are not queues. An application routed
          -- to a departed officer is an application nobody is told about, and
          -- the count returned here is what makes that visible.
          and a.disabled_at is null
          and ($8::uuid is null or a.id <> $8)
       -- The partial unique index carries the rule: at most one UNREAD notice
       -- per officer per application. A re-arrival the officer has already read
       -- about is news and is written; a second copy of something still sitting
       -- unread is not.
       on conflict do nothing
       returning id`,
      [notice.type, applicationId, role, notice.title, notice.body, notice.deepLink,
       role, exceptAccountId],
    );
    return result.rows.length;
  }

  async inboxFor(accountId: string, limit: number): Promise<readonly StaffNotificationRow[]> {
    const rows = await this.db.query<{
      id: string; type: string; application_id: string | null; routed_to_role: string;
      title: string; body: string; deep_link: string | null;
      created_at: Date; read_at: Date | null;
    }>(
      `select id, type, application_id, routed_to_role, title, body, deep_link,
              created_at, read_at
         from staff_notifications
        where account_id = $1
        order by read_at is not null, created_at desc
        limit $2`,
      [accountId, limit],
    );

    return rows.rows.map((row) => ({
      id: row.id,
      type: row.type,
      applicationId: row.application_id,
      routedToRole: row.routed_to_role,
      title: row.title,
      body: row.body,
      deepLink: row.deep_link,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at === null ? null : row.read_at.toISOString(),
    }));
  }

  /**
   * Marks one notice read, for THIS officer only.
   *
   * Scoped by account in the statement rather than checked first: a read that
   * decides and a write that acts are two moments, and between them the notice
   * could belong to someone else. Returns whether a row moved, so a caller
   * cannot report success for a notice it did not own.
   */
  async markRead(accountId: string, notificationId: string, now: Date): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `update staff_notifications set read_at = $1
        where id = $2 and account_id = $3 and read_at is null
        returning id`,
      [now, notificationId, accountId],
    );
    return result.rows.length > 0;
  }

  async unreadCount(accountId: string): Promise<number> {
    const result = await this.db.query<{ n: string }>(
      'select count(*) as n from staff_notifications where account_id = $1 and read_at is null',
      [accountId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }
}
