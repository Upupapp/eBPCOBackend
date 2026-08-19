import { SqlClient } from '../../../persistence/sql-client';
import { currentCorrelationId } from '../../../common/correlation/correlation';
import { ChainVerdict, ChainableEvent, GENESIS, hashEntry, verifyChain } from '../domain/audit-chain';

/**
 * The append-only record of what this system did, and who to.
 *
 * Coverage is deliberately wider than mutations. NPC Circular 16-01 expects a
 * government agency to account for who VIEWED personal data, not only who
 * changed it, so a document read and a personal-data export are audited events
 * in their own right. So is a refused authorisation: an attempt to reach
 * another applicant's record is exactly the thing anyone investigating an
 * incident wants to find.
 */

export type AuditOutcome = 'allowed' | 'denied' | 'failed';

export interface AuditInput {
  readonly action: string;
  readonly subjectType: 'application' | 'document' | 'payment' | 'order-of-payment' | 'account' | 'export';
  readonly subjectId: string | null;
  readonly outcome: AuditOutcome;
  readonly actorAccountId?: string | null;
  readonly actorRole?: string | null;
  readonly sourceAddress?: string | null;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
}

interface AuditRow {
  sequence: number;
  occurred_at: Date;
  actor_account_id: string | null;
  actor_role: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  outcome: AuditOutcome;
  correlation_id: string | null;
  before_state: unknown;
  after_state: unknown;
  entry_hash: string;
  previous_hash: string | null;
}

export class AuditService {
  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Appends one entry, chained to the last.
   *
   * Takes the chain head under a row lock, so two concurrent appends cannot
   * both claim the same predecessor. That serialises audit writes, which is a
   * real cost and the price of the chain meaning anything: two entries pointing
   * at one predecessor is indistinguishable from a forgery.
   *
   * Must be called inside the caller's transaction, so an audited act and its
   * record commit together or not at all.
   */
  async append(input: AuditInput, tx: SqlClient = this.db): Promise<number> {
    const head = await tx.query<{ last_hash: string; last_sequence: number }>(
      'select last_hash, last_sequence from audit_chain_head where id = 1 for update',
    );
    const previousHash = head.rows[0]?.last_hash ?? GENESIS;
    const sequence = Number(head.rows[0]?.last_sequence ?? 0) + 1;

    const event: ChainableEvent = {
      sequence,
      occurredAt: this.clock(),
      actorAccountId: input.actorAccountId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      // Picked up from the request context rather than passed in, so an
      // audited act is tied to the request that caused it without every call
      // site having to remember.
      correlationId: currentCorrelationId() ?? null,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
    };

    const entryHash = hashEntry(previousHash, event);

    await tx.query(
      `insert into audit_events
         (sequence, occurred_at, actor_account_id, actor_role, action, subject_type, subject_id,
          outcome, correlation_id, source_address, before_state, after_state, previous_hash, entry_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        sequence, event.occurredAt, event.actorAccountId, event.actorRole, event.action,
        event.subjectType, event.subjectId, event.outcome, event.correlationId,
        input.sourceAddress ?? null,
        event.beforeState === null ? null : JSON.stringify(event.beforeState),
        event.afterState === null ? null : JSON.stringify(event.afterState),
        previousHash, entryHash,
      ],
    );

    await tx.query(
      'update audit_chain_head set last_hash = $1, last_sequence = $2 where id = 1',
      [entryHash, sequence],
    );

    return sequence;
  }

  /** Walks the whole chain. Used by the integrity check and by an audit. */
  async verify(): Promise<ChainVerdict> {
    const rows = await this.db.query<AuditRow>(
      `select sequence, occurred_at, actor_account_id, actor_role, action, subject_type, subject_id,
              outcome, correlation_id, before_state, after_state, entry_hash, previous_hash
         from audit_events order by sequence`,
    );

    return verifyChain(
      rows.rows.map((row) => ({
        sequence: Number(row.sequence),
        occurredAt: row.occurred_at,
        actorAccountId: row.actor_account_id,
        actorRole: row.actor_role,
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        outcome: row.outcome,
        correlationId: row.correlation_id,
        beforeState: row.before_state,
        afterState: row.after_state,
        entryHash: row.entry_hash,
        previousHash: row.previous_hash,
      })),
    );
  }

  /**
   * "What happened to this application", answerable without a database query.
   *
   * A product feature, not a DBA task: an officer asked by an applicant why
   * their permit took three weeks needs to be able to answer, and an answer
   * that requires a ticket to the IT unit is not one.
   */
  async historyOf(subjectType: string, subjectId: string): Promise<ReadonlyArray<{
    sequence: number; occurredAt: Date; action: string; outcome: AuditOutcome;
    actorAccountId: string | null; actorRole: string | null;
  }>> {
    const rows = await this.db.query<AuditRow>(
      `select sequence, occurred_at, action, outcome, actor_account_id, actor_role
         from audit_events
        where subject_type = $1 and subject_id = $2
        order by sequence`,
      [subjectType, subjectId],
    );
    return rows.rows.map((row) => ({
      sequence: Number(row.sequence),
      occurredAt: row.occurred_at,
      action: row.action,
      outcome: row.outcome,
      actorAccountId: row.actor_account_id,
      actorRole: row.actor_role,
    }));
  }
}
