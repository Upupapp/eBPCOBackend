import { AccountKind, Scope, StaffRole } from '../../identity/domain/account';

/**
 * The lifecycle, as data.
 *
 * Every legal move, who may make it, what must already be true, and what it
 * causes — declared here rather than spread across service methods. Three
 * things follow from that which would not otherwise:
 *
 * A table-driven test can assert every legal move is permitted and every other
 * move is refused, without anyone having to remember to write a test per case.
 *
 * Permission and precondition are separable. "May this actor make this move"
 * and "is this application in a state where the move makes sense" are different
 * questions with different answers and different error codes, and conflating
 * them produces a 403 where the truth is "you haven't paid yet".
 *
 * The database enforces the same transition table independently (migration
 * 003). This is not duplication for its own sake: the database stops anything
 * that bypasses this service, and this service produces the specific,
 * actionable error a database exception cannot.
 */

export const LIFECYCLE_STATUSES = [
  'Draft', 'Submitted', 'Received', 'Document Verification', 'Under Evaluation',
  'Revision Required', 'Assessed', 'Payment Submitted', 'Payment Under Verification',
  'Payment Verified', 'For Approval', 'Approved', 'Permit Generated',
  'Ready for Release', 'Released', 'Completed', 'Rejected', 'Cancelled', 'Expired',
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const APPLICANT_STATUSES = [
  'Draft', 'Submitted', 'Under Review', 'Payment Verification',
  'Approved', 'Ready for Release', 'Rejected',
] as const;

export type ApplicantStatus = (typeof APPLICANT_STATUSES)[number];

/** What must already be true of the application for a move to be allowed. */
export type Precondition =
  | 'identity-document-verified'
  | 'required-documents-present'
  | 'all-instructions-resolved'
  | 'order-of-payment-issued'
  | 'payment-proof-submitted'
  | 'payment-verified'
  | 'evaluations-complete'
  | 'permit-generated';

export interface TransitionRule {
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  /** Who may initiate. An applicant may withdraw; only an officer may reject. */
  readonly actors: readonly AccountKind[];
  /** The scope a caller must hold. */
  readonly requires: Scope;
  readonly preconditions: readonly Precondition[];
  /** The catalog notification this move produces, if any. */
  readonly notifies?: string;
}

/**
 * Decision E-4 — may applicants cancel their own applications?
 *
 * Yes, until an Order of Payment exists. Before assessment nothing has changed
 * hands, and forcing someone to come in to withdraw defeats the zero-contact
 * policy the whole system exists to serve.
 *
 * From Assessed onward, no. An Order of Payment is an immutable financial
 * instrument: cancelling past that point either strands a payment the applicant
 * already made — a refund, which is a Treasury process with its own rules — or
 * requires the Order to be formally voided, which is an officer's act. The
 * applicant can still ask; it becomes a request an officer decides on, which is
 * why 'Assessed' -> 'Cancelled' remains a legal transition with staff-only
 * actors rather than being removed.
 *
 * See docs/decisions/0007-applicant-cancellation.md.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'Draft', to: 'Submitted', actors: ['applicant'], requires: 'applications:write',
    preconditions: ['identity-document-verified', 'required-documents-present'],
    notifies: 'application.submitted' },
  { from: 'Draft', to: 'Cancelled', actors: ['applicant'], requires: 'applications:write',
    preconditions: [] },

  { from: 'Submitted', to: 'Received', actors: ['staff'], requires: 'applications:read',
    preconditions: [], notifies: 'application.received' },
  { from: 'Submitted', to: 'Cancelled', actors: ['applicant', 'staff'], requires: 'applications:write',
    preconditions: [], notifies: 'application.cancelled' },

  { from: 'Received', to: 'Document Verification', actors: ['staff'], requires: 'documents:read',
    preconditions: [], notifies: 'application.document-verification-started' },
  { from: 'Received', to: 'Cancelled', actors: ['applicant', 'staff'], requires: 'applications:write',
    preconditions: [], notifies: 'application.cancelled' },

  { from: 'Document Verification', to: 'Under Evaluation', actors: ['staff'], requires: 'staff:evaluate',
    preconditions: ['identity-document-verified', 'required-documents-present'],
    notifies: 'application.evaluation-started' },
  { from: 'Document Verification', to: 'Revision Required', actors: ['staff'], requires: 'staff:evaluate',
    preconditions: [], notifies: 'application.revision-required' },
  { from: 'Document Verification', to: 'Rejected', actors: ['staff'], requires: 'staff:approve',
    preconditions: [], notifies: 'application.rejected' },

  { from: 'Under Evaluation', to: 'Assessed', actors: ['staff'], requires: 'staff:assess',
    preconditions: ['evaluations-complete', 'order-of-payment-issued'],
    notifies: 'application.assessed' },
  { from: 'Under Evaluation', to: 'Revision Required', actors: ['staff'], requires: 'staff:evaluate',
    preconditions: [], notifies: 'application.revision-required' },
  { from: 'Under Evaluation', to: 'Rejected', actors: ['staff'], requires: 'staff:approve',
    preconditions: [], notifies: 'application.rejected' },

  { from: 'Revision Required', to: 'Under Evaluation', actors: ['applicant'], requires: 'applications:write',
    preconditions: ['all-instructions-resolved'], notifies: 'application.instruction-resolved' },
  { from: 'Revision Required', to: 'Cancelled', actors: ['applicant', 'staff'], requires: 'applications:write',
    preconditions: [], notifies: 'application.cancelled' },
  { from: 'Revision Required', to: 'Expired', actors: ['staff'], requires: 'applications:write',
    preconditions: [], notifies: 'application.expired' },

  // Applicant-initiated cancellation stops here: past this point an Order of
  // Payment exists and cancelling touches money (decision E-4).
  { from: 'Assessed', to: 'Payment Submitted', actors: ['applicant'], requires: 'payments:write',
    preconditions: ['order-of-payment-issued', 'payment-proof-submitted'],
    notifies: 'application.payment-submitted' },
  { from: 'Assessed', to: 'Cancelled', actors: ['staff'], requires: 'staff:assess',
    preconditions: [], notifies: 'application.cancelled' },
  { from: 'Assessed', to: 'Expired', actors: ['staff'], requires: 'staff:assess',
    preconditions: [], notifies: 'application.expired' },

  { from: 'Payment Submitted', to: 'Payment Under Verification', actors: ['staff'],
    requires: 'staff:verify-payment', preconditions: ['payment-proof-submitted'],
    notifies: 'application.payment-under-verification' },

  { from: 'Payment Under Verification', to: 'Payment Verified', actors: ['staff'],
    requires: 'staff:verify-payment', preconditions: ['payment-verified'],
    notifies: 'application.payment-verified' },
  { from: 'Payment Under Verification', to: 'Payment Submitted', actors: ['staff'],
    requires: 'staff:verify-payment', preconditions: [],
    notifies: 'application.payment-rejected' },

  { from: 'Payment Verified', to: 'For Approval', actors: ['staff'], requires: 'staff:verify-payment',
    preconditions: ['payment-verified'], notifies: 'application.for-approval' },

  { from: 'For Approval', to: 'Approved', actors: ['staff'], requires: 'staff:approve',
    preconditions: ['payment-verified', 'evaluations-complete'], notifies: 'application.approved' },
  { from: 'For Approval', to: 'Revision Required', actors: ['staff'], requires: 'staff:approve',
    preconditions: [], notifies: 'application.revision-required' },
  { from: 'For Approval', to: 'Rejected', actors: ['staff'], requires: 'staff:approve',
    preconditions: [], notifies: 'application.rejected' },

  { from: 'Approved', to: 'Permit Generated', actors: ['staff'], requires: 'staff:approve',
    preconditions: [], notifies: 'application.permit-generated' },

  { from: 'Permit Generated', to: 'Ready for Release', actors: ['staff'], requires: 'staff:release',
    preconditions: ['permit-generated'], notifies: 'application.ready-for-release' },

  { from: 'Ready for Release', to: 'Released', actors: ['staff'], requires: 'staff:release',
    preconditions: ['permit-generated'], notifies: 'application.released' },

  { from: 'Released', to: 'Completed', actors: ['staff'], requires: 'staff:release',
    preconditions: [], notifies: 'application.completed' },
];

const BY_PAIR = new Map(TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]));

export function ruleFor(from: LifecycleStatus, to: LifecycleStatus): TransitionRule | undefined {
  return BY_PAIR.get(`${from}->${to}`);
}

export function legalMovesFrom(from: LifecycleStatus): readonly LifecycleStatus[] {
  return TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to);
}

/**
 * The 19 → 7 projection. Computed here, server-side, once, and returned in the
 * payload. Neither client may recompute it -- that is how two vocabularies fork.
 */
const APPLICANT_PROJECTION: Readonly<Record<LifecycleStatus, ApplicantStatus>> = {
  Draft: 'Draft',
  Submitted: 'Submitted',
  Received: 'Submitted',
  'Document Verification': 'Under Review',
  'Under Evaluation': 'Under Review',
  'Revision Required': 'Under Review',
  Assessed: 'Payment Verification',
  'Payment Submitted': 'Payment Verification',
  'Payment Under Verification': 'Payment Verification',
  'Payment Verified': 'Payment Verification',
  'For Approval': 'Payment Verification',
  Approved: 'Approved',
  'Permit Generated': 'Approved',
  'Ready for Release': 'Ready for Release',
  Released: 'Ready for Release',
  Completed: 'Ready for Release',
  Rejected: 'Rejected',
  Cancelled: 'Rejected',
  Expired: 'Rejected',
};

export const applicantStatusOf = (status: LifecycleStatus): ApplicantStatus =>
  APPLICANT_PROJECTION[status];

const TERMINAL: ReadonlySet<LifecycleStatus> = new Set(['Completed', 'Rejected', 'Cancelled', 'Expired']);
export const isTerminal = (status: LifecycleStatus): boolean => TERMINAL.has(status);

/**
 * Whether the LGU is waiting on the applicant.
 *
 * Deliberately independent of the applicant status: 'Revision Required' and
 * 'Assessed' both project onto passive-sounding headlines that give the
 * applicant no hint they are the one holding the application up.
 */
const AWAITING_APPLICANT: ReadonlySet<LifecycleStatus> = new Set([
  'Revision Required', 'Assessed', 'Ready for Release',
]);
export const requiresApplicantAction = (status: LifecycleStatus): boolean =>
  AWAITING_APPLICANT.has(status);

/** A pledge countdown is only meaningful while the LGU still owes an act. */
export const pledgeApplies = (status: LifecycleStatus): boolean =>
  status !== 'Draft' && !isTerminal(status);

/** The RA 11032 clock stops while the applicant holds a deficiency. */
export const pledgeSuspended = (status: LifecycleStatus): boolean =>
  status === 'Revision Required';

export const rolesGranting = (scope: Scope, roleScopes: Readonly<Record<StaffRole, readonly Scope[]>>): StaffRole[] =>
  (Object.keys(roleScopes) as StaffRole[]).filter((role) => roleScopes[role].includes(scope));
