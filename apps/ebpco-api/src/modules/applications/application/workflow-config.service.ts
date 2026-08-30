import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { ROLE_SCOPES, StaffRole, isReadOnlyRole } from '../../identity/domain/account';
import { LIFECYCLE_STATUSES, LifecycleStatus, TransitionRule, isTerminal } from '../domain/lifecycle';
import { loadTransitions } from '../domain/transition-repository';
import { StaffNotificationService } from '../../notifications/application/staff-notification.service';
import { workflowChanged } from '../../notifications/domain/staff-catalog';

/**
 * Editing the lifecycle. Owner decision D-5, 2026-08-29.
 *
 * ── What is deliberately permitted ──────────────────────────────────────
 *
 * Everything about a move: who may make it, what scope it needs, what must be
 * true first, and what the applicant is told. That includes weakening the
 * separation of duty the rest of this service is built on — an LGU can make
 * 'Payment Verified' -> 'For Approval' require `applications:read` and every
 * officer can then approve.
 *
 * That was chosen with the consequence stated. What is NOT done is accept it
 * silently: a change that widens who can make a move is returned as a WARNING
 * naming what it gave up, and every change is audited with its before and after.
 * An LGU is entitled to configure its own process; it is also entitled to be
 * told when it has just removed a control.
 *
 * ── What is refused ─────────────────────────────────────────────────────
 *
 * Stranding. A status with applications in it and no legal move out is not a
 * policy choice — it is a queue of citizens whose permits can never proceed,
 * with no error anywhere saying why. Nobody decides that on purpose, so it is
 * the one edit this refuses.
 */

export interface TransitionInput {
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  readonly actors: readonly ('applicant' | 'staff')[];
  readonly requiresScope: string;
  readonly preconditions: readonly string[];
  readonly notifies: string | null;
}

export type WorkflowResult =
  | {
      readonly ok: true;
      readonly transitions: readonly TransitionRule[];
      /** Controls this edit gave up. Empty is the common case. */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** Scopes ordered by how few officers hold them. Widening moves down this list. */
const NARROWNESS: readonly string[] = [
  'staff:administer', 'staff:approve', 'staff:release', 'staff:assess',
  'staff:verify-payment', 'staff:evaluate', 'documents:write', 'applications:write',
  'documents:read', 'applications:read',
];

export class WorkflowConfigService {
  private readonly audit: AuditService;
  private readonly staffNotices: StaffNotificationService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
    staffNotices?: StaffNotificationService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
    this.staffNotices = staffNotices ?? new StaffNotificationService(db);
  }

  current(): Promise<readonly TransitionRule[]> {
    return loadTransitions(this.db);
  }

  /**
   * Replaces the whole table.
   *
   * Wholesale, because a lifecycle is a graph and a graph is only correct as a
   * whole: adding one edge and removing another are the same edit, and a
   * per-edge API would let a client leave the graph broken between two calls.
   */
  async replace(options: {
    transitions: readonly TransitionInput[]; officer: Caller;
  }): Promise<WorkflowResult> {
    const { transitions, officer } = options;

    if (transitions.length === 0) {
      return {
        ok: false, reason: 'empty',
        detail: 'A lifecycle with no moves means no application can ever change status.',
      };
    }

    const statuses = new Set<string>(LIFECYCLE_STATUSES);
    for (const move of transitions) {
      if (!statuses.has(move.from) || !statuses.has(move.to)) {
        return {
          ok: false, reason: 'unknown-status',
          detail: `"${move.from}" -> "${move.to}" names a status this system does not have. `
            + 'Statuses are fixed; the moves between them are not.',
        };
      }
      if (move.from === move.to) {
        return {
          ok: false, reason: 'not-a-move',
          detail: `"${move.from}" cannot transition to itself.`,
        };
      }
    }

    // A read-only role gaining authority is refused, not warned about.
    //
    // D-5's line is that weakening separation of duty is PERMITTED and never
    // silent -- an LGU may decide any officer can approve. This is on the other
    // side of that line for a reason the codebase already states elsewhere: an
    // administrator who genuinely needs to assess "can be given the assessor
    // role as well -- visibly, in the role table, where it can be audited".
    // Gaining authority belongs in the role table, not as a side effect of
    // editing a workflow.
    //
    // And this is not hypothetical. Until 2026-08-30 `Submitted -> Received`
    // required `applications:read`, which `auditor` holds, so the
    // read-everything-change-nothing role could move applications. That was
    // fixed in the seed; without this check the editor could put it straight
    // back, one PUT at a time, with only a warning.
    const escalating = readOnlyRolesGaining(transitions);
    if (escalating.length > 0) {
      return {
        ok: false, reason: 'read-only-role-would-gain-authority',
        detail: `${escalating.join('; ')}. A role defined as read-only must not gain the `
          + 'power to act by a workflow edit. Give the officer an acting role in Users & '
          + 'Roles instead, where it is visible and audited.',
      };
    }

    const stranded = strandedStatuses(transitions);
    if (stranded.length > 0) {
      return {
        ok: false, reason: 'stranded',
        detail: `${stranded.join(', ')} would have no legal move out and would not be a terminal `
          + 'status. Every application in that status could never proceed, and nothing would say why.',
      };
    }

    const before = await this.current();
    const warnings = controlsGivenUp(before, transitions);

    return this.db.transaction(async (tx) => {
      const inUse = await tx.query<{ lifecycle_status: string; n: string }>(
        `select lifecycle_status, count(*) as n from applications
          where archived_at is null group by lifecycle_status`,
      );
      const reachable = new Set(transitions.map((move) => move.from));
      const orphaned = inUse.rows
        .filter((row) => Number(row.n) > 0)
        .map((row) => row.lifecycle_status as LifecycleStatus)
        .filter((status) => !isTerminal(status) && !reachable.has(status));
      if (orphaned.length > 0) {
        // The same refusal as above, but about applications that exist RIGHT
        // NOW rather than about the shape of the graph. A lifecycle can be
        // perfectly well-formed and still strand the queue it inherited.
        return {
          ok: false as const, reason: 'strands-live-applications',
          detail: `Applications are currently in ${orphaned.join(', ')}, and this lifecycle gives `
            + 'them no move out. Move them first, or keep a transition from each.',
        };
      }

      await tx.query('delete from lifecycle_transitions');
      for (const [ordinal, move] of transitions.entries()) {
        await tx.query(
          `insert into lifecycle_transitions
             (from_status, to_status, actors, requires_scope, preconditions, notifies,
              ordinal, updated_at, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [move.from, move.to, move.actors, move.requiresScope, move.preconditions,
           // The order the client sent them in. Reordering the array reorders
           // the flow chart; there is no separate field to keep in step.
           move.notifies, ordinal, this.clock(), officer.accountId],
        );
      }

      await this.audit.append({
        action: 'workflow.replaced',
        subjectType: 'application',
        subjectId: null,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        actorRole: officer.kind,
        beforeState: { transitions: before },
        // The warnings are recorded, not just returned. An officer who widened
        // approval and closed the tab is the case this exists for.
        afterState: { transitions, controlsGivenUp: warnings },
      }, tx);

      // TAB 14 / D-7. The routing rule IS the transition table, so an edit here
      // silently changes whose queue an application lands in. Every officer is
      // told, including the ones whose queue got smaller -- "my work stopped
      // arriving" is the failure that otherwise takes a week to notice.
      await this.staffNotices.announceToAll(tx, workflowChanged(), officer.accountId);

      return { ok: true as const, transitions: await loadTransitions(tx), warnings };
    });
  }
}

/**
 * Read-only roles that this lifecycle would let act.
 *
 * Reported per role and move rather than as a count: "the auditor could make
 * Payment Verified -> For Approval" is actionable, and "1 problem" is not.
 */
function readOnlyRolesGaining(transitions: readonly TransitionInput[]): string[] {
  const found: string[] = [];
  for (const role of (Object.keys(ROLE_SCOPES) as StaffRole[]).filter(isReadOnlyRole)) {
    const held = new Set<string>(ROLE_SCOPES[role]);
    for (const move of transitions) {
      if (!move.actors.includes('staff') || !held.has(move.requiresScope)) continue;
      found.push(
        `${role} is a read-only role and would be able to make ${move.from} -> ${move.to}, `
        + `which requires ${move.requiresScope}`,
      );
    }
  }
  return found;
}

/**
 * Statuses an application could enter and never leave.
 *
 * Terminal statuses are meant to have no way out; everything else having none
 * is the defect.
 */
function strandedStatuses(transitions: readonly TransitionInput[]): string[] {
  const out = new Set(transitions.map((move) => move.from));
  const entered = new Set(transitions.map((move) => move.to));

  return [...entered]
    .filter((status) => !out.has(status))
    .filter((status) => !isTerminal(status))
    .sort();
}

/** Says plainly what a change gave up, so it is a decision rather than a side effect. */
function controlsGivenUp(
  before: readonly TransitionRule[], after: readonly TransitionInput[],
): string[] {
  const warnings: string[] = [];
  const previous = new Map(before.map((rule) => [`${rule.from}->${rule.to}`, rule]));

  for (const move of after) {
    const was = previous.get(`${move.from}->${move.to}`);
    if (was === undefined) {
      warnings.push(`${move.from} -> ${move.to} is a new move that did not exist before.`);
      continue;
    }

    const wasIndex = NARROWNESS.indexOf(was.requires);
    const nowIndex = NARROWNESS.indexOf(move.requiresScope);
    if (wasIndex !== -1 && nowIndex > wasIndex) {
      warnings.push(
        `${move.from} -> ${move.to} now needs only ${move.requiresScope} instead of ${was.requires}, `
        + 'so more officers can make it.',
      );
    }
    const dropped = was.preconditions.filter((rule) => !move.preconditions.includes(rule));
    if (dropped.length > 0) {
      warnings.push(
        `${move.from} -> ${move.to} no longer requires ${dropped.join(', ')} to be true first.`,
      );
    }
    if (!was.actors.includes('applicant') && move.actors.includes('applicant')) {
      warnings.push(`${move.from} -> ${move.to} can now be made by an applicant.`);
    }
  }
  return warnings;
}
