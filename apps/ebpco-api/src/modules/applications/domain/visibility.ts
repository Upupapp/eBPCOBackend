import { Caller } from './application';
import { LifecycleStatus } from './lifecycle';

/**
 * Which applications a caller may see at all.
 *
 * Lives in the domain rather than beside the queue that first needed it. The
 * evaluations worklist needs the same rule, and importing it from the queue
 * service created a cycle — the queue reads evaluations, evaluations would read
 * the queue — which this codebase already knows resolves to `undefined` at
 * exactly the wrong moment.
 *
 * That it is needed twice is the argument for it being a domain rule and not a
 * detail of one screen: it decides what an officer is entitled to read, which
 * is not a property of any particular list.
 */
/**
 * Least privilege, expressed as a row filter rather than a UI decision.
 *
 * A cashier has no reason to read an application that has not reached
 * assessment, and a releasing officer has no reason to read one that has not
 * been approved. Hiding those rows in the client would still send them; this
 * refuses to select them. Roles that legitimately see the whole pipeline --
 * records, building official, administrator -- are listed explicitly, so
 * granting that breadth to a new role is a visible change here rather than an
 * accident of an omitted case.
 */
const SCOPE_VISIBILITY: ReadonlyArray<{ scope: string; statuses: readonly LifecycleStatus[] | 'all' }> = [
  { scope: 'staff:administer', statuses: 'all' },
  // Oversight reads everything: that is the definition of the role, stated in
  // ROLE_SCOPES as "READ EVERYTHING, CHANGE NOTHING". `auditor` was added by the
  // web-portal reconciliation and this table was not updated with it, so the
  // role that exists to read everything could read NO application at all --
  // exactly the "accident of an omitted case" the comment above warns about,
  // committed by the mechanism meant to prevent it. Found 2026-08-30.
  { scope: 'audit:read', statuses: 'all' },
  // Intake. Added with `auditor` above, for `receiving-officer`, which matched
  // no rule here at all: it could see nothing, while the transition table gave
  // it precisely two moves to make. An officer assigned work by one table and
  // refused sight of it by another gets a 404 and no explanation anywhere.
  //
  // Keyed on `staff:receive` rather than `documents:read`, so that reading
  // documents does not by itself confer sight of the intake queue. The auditor
  // holds `documents:read` and must not gain a queue; it sees everything
  // through `audit:read` above, which grants sight and no authority.
  { scope: 'staff:receive', statuses: ['Submitted', 'Received', 'Document Verification'] },
  { scope: 'applications:write', statuses: 'all' },
  { scope: 'staff:approve', statuses: 'all' },
  { scope: 'staff:evaluate', statuses: ['Submitted', 'Received', 'Document Verification', 'Under Evaluation', 'Revision Required'] },
  { scope: 'staff:assess', statuses: ['Under Evaluation', 'Assessed'] },
  { scope: 'staff:verify-payment', statuses: ['Assessed', 'Payment Submitted', 'Payment Under Verification', 'Payment Verified'] },
  { scope: 'staff:release', statuses: ['Approved', 'Permit Generated', 'Ready for Release', 'Released', 'Completed'] },
];

/**
 * Which statuses this caller may see at all. Empty means none -- and an empty
 * result is the correct answer for a staff account holding no read-bearing
 * scope, rather than an error, because a role can legitimately exist that only
 * administers accounts.
 */
export function visibleStatusesFor(caller: Caller): readonly LifecycleStatus[] | 'all' {
  if (caller.kind !== 'staff') return [];
  const held = new Set(caller.scopes);
  const matched = SCOPE_VISIBILITY.filter((rule) => held.has(rule.scope));
  if (matched.some((rule) => rule.statuses === 'all')) return 'all';
  const union = new Set<LifecycleStatus>();
  for (const rule of matched) {
    if (rule.statuses !== 'all') rule.statuses.forEach((s) => union.add(s));
  }
  return [...union];
}
