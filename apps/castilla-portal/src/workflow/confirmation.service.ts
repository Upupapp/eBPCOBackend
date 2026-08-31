import { audit } from '../audit/audit';
import { ContentVersions } from '../http/cache';
import { invalidateFor } from '../http/invalidation';
import { inTransaction } from '../persistence/transaction';
import { requiresTwoPeople } from './four-eyes';

export interface Sql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ProposalInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly proposedValue: string;
  readonly sourceDescription: string;
  readonly sourceUrl?: string;
  readonly sourcedOn: string;
  readonly method: 'direct-read' | 'search-extraction' | 'official-document';
  readonly proposedBy: string;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface BacklogEntry {
  readonly entityType: string;
  readonly entityId: string;
  readonly label: string;
  readonly pendingFields: readonly string[];
}

/**
 * The confirmation workflow.
 *
 * ── Proposals are not live ──────────────────────────────────────────────
 *
 * Nothing a proposal says reaches a citizen until a second act confirms it.
 * That is what makes the four-eyes rule meaningful: if proposing changed the
 * public record, the rule would only delay the harm.
 *
 * ── Confirmation is one transaction or none of it ───────────────────────
 *
 * The provenance row and the state change are written together. A confirmed
 * value without its source must be impossible, and the schema enforces that
 * independently -- so a bug here fails loudly at COMMIT rather than leaving an
 * unsourced fact in front of the public.
 */
export class ConfirmationService {
  constructor(
    private readonly db: Sql,
    private readonly clock: () => Date = () => new Date(),
    /**
     * Optional: the workflow is usable without a cache, and the tests that
     * predate TAB 13 construct it with two arguments.
     */
    private readonly versions?: ContentVersions,
  ) {}

  /**
   * Expire what this change made stale — AFTER the transaction, never inside.
   * Invalidating within it would expire caches for a change that then rolled
   * back, buying a revalidation storm for nothing.
   */
  private async invalidate(entityType: string, entityId: string): Promise<void> {
    if (this.versions === undefined) return;
    await invalidateFor(this.versions, this.db, entityType, entityId);
  }

  async propose(input: ProposalInput): Promise<Outcome<string>> {
    if (input.sourceDescription.trim().length < 8) {
      // The same floor the database holds, refused here so a person gets a
      // sentence rather than a constraint violation. 'LGU' is not a source.
      return {
        ok: false, reason: 'source-too-thin',
        detail: 'A proposal must say where the value came from. A source is a description '
          + 'someone else could check — an office, a document, a page, and when it was read.',
      };
    }

    try {
      const created = await this.db.query<{ id: string }>(
        `insert into proposals (entity_type, entity_id, field_name, proposed_value,
                                previous_value, source_description, source_url, sourced_on,
                                method, proposed_by)
         values ($1,$2,$3,$4,
                 (select value from field_value_history
                   where entity_type = $1 and entity_id = $2 and field_name = $3
                   order by recorded_at desc limit 1),
                 $5,$6,$7::date,$8::provenance_method,$9)
         returning id`,
        [input.entityType, input.entityId, input.fieldName, input.proposedValue,
         input.sourceDescription, input.sourceUrl ?? null, input.sourcedOn,
         input.method, input.proposedBy],
      );
      return { ok: true, value: created.rows[0]!.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          ok: false, reason: 'already-open',
          detail: 'Another proposal for this field is already open. Two people proposing '
            + 'different values is a conversation to have before either is confirmed, not a '
            + 'race to confirm first.',
        };
      }
      throw error;
    }
  }

  /**
   * Confirms an open proposal.
   *
   * ── How the concurrency requirement is met ──────────────────────────
   *
   * The status transition is the lock. `update ... where status = 'open'
   * returning id` succeeds for exactly one caller; the loser sees no row and is
   * told so. Nothing here reads-then-writes, so there is no window between the
   * check and the act -- which is the shape that produces two provenance rows
   * racing.
   */
  async confirm(proposalId: string, confirmedBy: string): Promise<Outcome<void>> {
    const found = await this.db.query<{
      entity_type: string; entity_id: string; field_name: string; proposed_value: string;
      source_description: string; source_url: string | null; sourced_on: string;
      method: string; proposed_by: string; status: string;
    }>('select * from proposals where id = $1', [proposalId]);

    const proposal = found.rows[0];
    if (proposal === undefined) {
      return { ok: false, reason: 'not-found', detail: 'No such proposal.' };
    }
    if (proposal.status !== 'open') {
      return {
        ok: false, reason: 'not-open',
        detail: `This proposal is already ${proposal.status}.`,
      };
    }

    if (proposal.proposed_by === confirmedBy
        && requiresTwoPeople(proposal.entity_type, proposal.field_name)) {
      return {
        ok: false, reason: 'four-eyes',
        detail: 'A change to a named individual or a contact detail must be confirmed by '
          + 'someone other than the person who proposed it. These are facts about real '
          + 'people, and one account doing both halves is the whole of the control.',
      };
    }

    // ONE TRANSACTION, ALL OF IT. The state change, its provenance, the value
    // history and the audit row commit together or none of them do. Anything
    // less leaves either a published fact no audit row explains, or a trail
    // claiming a change that was rolled back — and both are worse than a
    // failure, because both look like the truth.
    const result = await inTransaction(this.db, async (tx) => {
      // The transition IS the lock: exactly one caller moves it out of 'open'.
      const won = await tx.query<{ id: string }>(
        `update proposals set status = 'confirmed', decided_by = $2, decided_at = $3
          where id = $1 and status = 'open' returning id`,
        [proposalId, confirmedBy, this.clock()],
      );
      if (won.rows.length === 0) {
        return {
          ok: false as const, reason: 'lost-the-race',
          detail: 'Another confirmation of this proposal completed first.',
        };
      }

      const sourced = await tx.query<{ id: string }>(
        `insert into provenance (entity_type, entity_id, field_name, source_description,
                                 source_url, sourced_on, method)
         values ($1,$2,$3,$4,$5,$6::date,$7::provenance_method)
         returning id`,
        [proposal.entity_type, proposal.entity_id, proposal.field_name,
         proposal.source_description, proposal.source_url, proposal.sourced_on, proposal.method],
      );

      // Read BEFORE the write, so the audit row can say what it replaced.
      const previous = await tx.query<{ value: string }>(
        `select value from field_value_history
          where entity_type = $1 and entity_id = $2 and field_name = $3
          order by recorded_at desc limit 1`,
        [proposal.entity_type, proposal.entity_id, proposal.field_name],
      );

      await tx.query(
        `insert into field_state (entity_type, entity_id, field_name, state)
         values ($1,$2,$3,'confirmed')
         on conflict (entity_type, entity_id, field_name)
         do update set state = 'confirmed', updated_at = now()`,
        [proposal.entity_type, proposal.entity_id, proposal.field_name],
      );

      await tx.query(
        `insert into field_value_history (entity_type, entity_id, field_name, value, state,
                                          proposal_id, recorded_by)
         values ($1,$2,$3,$4,'confirmed',$5,$6)`,
        [proposal.entity_type, proposal.entity_id, proposal.field_name,
         proposal.proposed_value, proposalId, confirmedBy],
      );

      await audit(tx, {
        actor: confirmedBy, action: 'confirmed',
        entityType: proposal.entity_type, entityId: proposal.entity_id,
        fieldName: proposal.field_name,
        priorValue: previous.rows[0]?.value ?? null,
        newValue: proposal.proposed_value,
        // The source the confirmation rested on, one hop away rather than a
        // join nobody remembers to make.
        provenanceId: sourced.rows[0]?.id ?? null,
        detail: `proposed by ${proposal.proposed_by}`,
      });

      return { ok: true as const, value: undefined };
    });

    if (result.ok) await this.invalidate(proposal.entity_type, proposal.entity_id);
    return result;
  }

  /**
   * Returns a confirmed field to pending, keeping everything.
   *
   * The prior value stays in history and its provenance stays where it is:
   * provenance is append-only by construction, so reverting adds to the trail
   * rather than editing it. The LGU will contradict itself occasionally, and
   * what makes that resolvable is being able to read both claims in order.
   */
  async revert(
    entityType: string, entityId: string, fieldName: string, revertedBy: string,
  ): Promise<Outcome<void>> {
    const current = await this.db.query<{ state: string }>(
      `select state::text from field_state
        where entity_type = $1 and entity_id = $2 and field_name = $3`,
      [entityType, entityId, fieldName],
    );
    if (current.rows[0]?.state !== 'confirmed') {
      return {
        ok: false, reason: 'not-confirmed',
        detail: 'Only a confirmed field can be returned to pending.',
      };
    }

    const last = await this.db.query<{ value: string }>(
      `select value from field_value_history
        where entity_type = $1 and entity_id = $2 and field_name = $3
        order by recorded_at desc limit 1`,
      [entityType, entityId, fieldName],
    );

    await inTransaction(this.db, async (tx) => {
      await tx.query(
        `update field_state set state = 'pending', updated_at = now()
          where entity_type = $1 and entity_id = $2 and field_name = $3`,
        [entityType, entityId, fieldName],
      );
      await tx.query(
        `insert into field_value_history (entity_type, entity_id, field_name, value, state,
                                          recorded_by)
         values ($1,$2,$3,$4,'pending',$5)`,
        // The value is carried forward, not cleared. Reverting says "we are no
        // longer standing behind this", not "we never knew it" -- and the draft
        // value is where the next confirmation conversation starts.
        [entityType, entityId, fieldName, last.rows[0]?.value ?? '', revertedBy],
      );

      await audit(tx, {
        actor: revertedBy, action: 'reverted',
        entityType, entityId, fieldName,
        priorValue: last.rows[0]?.value ?? null,
        // No new value: reverting changes the STATE, not the text.
        detail: 'confirmed -> pending',
      });

      return { ok: true as const, value: undefined };
    });

    // A revert removes a fact from public view — arguably the moment where a
    // stale cache does the most harm, since the alternative is serving
    // something the LGU has just stopped standing behind.
    await this.invalidate(entityType, entityId);
    return { ok: true, value: undefined };
  }

  /**
   * Everything the LGU has not confirmed, grouped by entity.
   *
   * Grouped, not listed field by field, because that is how the work is done: a
   * person confirming an office's contact confirms its telephone, email,
   * location and hours in one sitting. A flat list of 36 contact fields
   * describes the same backlog and reads as four times the work.
   */
  /**
   * Who proposed this, so the authorisation layer can apply the four-eyes rule
   * before the handler runs. Null when there is no open proposal by that id.
   */
  async authorOf(proposalId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ proposed_by: string }>(
      "select proposed_by from proposals where id = $1 and status = 'open'", [proposalId]);
    return rows[0]?.proposed_by ?? null;
  }

  async backlog(): Promise<BacklogEntry[]> {
    const rows = await this.db.query<{
      entity_type: string; entity_id: string; field_name: string; label: string | null;
    }>(`
      select f.entity_type, f.entity_id, f.field_name,
             coalesce(o.name, ofc.name, p.name, pf.label) as label
        from field_state f
        left join offices   o   on f.entity_type = 'office'   and o.id::text   = f.entity_id
        left join officials ofc on f.entity_type = 'official'  and ofc.id::text = f.entity_id
        left join permits   p   on f.entity_type = 'permit'    and p.id::text   = f.entity_id
        left join profile_fields pf on f.entity_type = 'profile' and pf.id::text = f.entity_id
       where f.state = 'pending'
       order by f.entity_type, label, f.field_name`);

    const grouped = new Map<string, BacklogEntry & { pendingFields: string[] }>();
    for (const row of rows.rows) {
      const key = `${row.entity_type}:${row.entity_id}`;
      const entry = grouped.get(key) ?? {
        entityType: row.entity_type, entityId: row.entity_id,
        label: row.label ?? row.entity_id, pendingFields: [],
      };
      entry.pendingFields.push(row.field_name);
      grouped.set(key, entry);
    }
    return [...grouped.values()];
  }
}

function isUniqueViolation(error: unknown): boolean {
  const named = error as { code?: string; message?: string };
  return named.code === '23505' || /duplicate key|unique constraint/i.test(named.message ?? '');
}
