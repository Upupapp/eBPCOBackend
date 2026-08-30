import { SqlClient } from '../../../persistence/sql-client';
import { AccountKind, Scope } from '../../identity/domain/account';
import { LifecycleStatus, Precondition, TransitionRule } from './lifecycle';

/**
 * The lifecycle rules as they stand right now.
 *
 * Since D-5 these are configuration, so this is the only place that knows what
 * a move requires. The compiled `TRANSITIONS` seeds a fresh database and is
 * compared against this table by a spec; it is not consulted at runtime.
 *
 * Read fresh rather than cached. An LGU that edits the lifecycle and finds the
 * next transition still refused by the old rules would reasonably conclude the
 * edit did not work — and a cache invalidated by hand is a cache that is wrong
 * on the day it matters. Thirty-odd rows on a transition is not the cost worth
 * optimising here.
 */
export async function loadTransitions(db: SqlClient): Promise<readonly TransitionRule[]> {
  const rows = await db.query<{
    from_status: LifecycleStatus;
    to_status: LifecycleStatus;
    actors: AccountKind[];
    requires_scope: Scope;
    preconditions: Precondition[];
    notifies: string | null;
  }>(
    // `ordinal`, not alphabetically. The portal draws a flow chart from this and
    // the engine lists the legal moves in its error messages; "Draft, Submitted,
    // Received" reads as a process and "Approved, Assessed, Cancelled" reads as
    // an index. A set has no order, so the order is stored.
    `select from_status, to_status, actors, requires_scope, preconditions, notifies
       from lifecycle_transitions
      order by ordinal, from_status, to_status`,
  );

  return rows.rows.map((row) => ({
    from: row.from_status,
    to: row.to_status,
    actors: row.actors,
    requires: row.requires_scope,
    preconditions: row.preconditions,
    // Absent rather than null: `notifies?: string` means "this move tells the
    // applicant nothing", and a null would have to be checked for separately
    // everywhere the field is read.
    ...(row.notifies === null ? {} : { notifies: row.notifies }),
  }));
}
