import { LifecycleStatus, Precondition } from './lifecycle';

/**
 * Why a move was refused.
 *
 * Separate types rather than one error with a string, because each maps to a
 * different HTTP status and a different thing the caller should do:
 * an unknown transition is a bug in the caller, a forbidden one is a
 * permissions problem, and an unmet precondition is a step the applicant or
 * officer has not done yet -- and telling someone "forbidden" when the truth is
 * "you have not paid" sends them to the wrong place entirely.
 */

export type RefusalKind = 'illegal-transition' | 'not-permitted' | 'precondition-unmet' | 'stale-version';

export interface IllegalTransition {
  readonly kind: 'illegal-transition';
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  readonly legalMoves: readonly LifecycleStatus[];
}

export interface NotPermitted {
  readonly kind: 'not-permitted';
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  /** Which of the two failed: being the wrong kind of account, or lacking the scope. */
  readonly reason: 'wrong-actor' | 'missing-scope';
  readonly requiredScope: string;
}

export interface PreconditionUnmet {
  readonly kind: 'precondition-unmet';
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  /** Named, so the response can say what is missing rather than that something is. */
  readonly unmet: readonly Precondition[];
}

export interface StaleVersion {
  readonly kind: 'stale-version';
  readonly expected: number;
  readonly actual: number;
}

export type Refusal = IllegalTransition | NotPermitted | PreconditionUnmet | StaleVersion;

/** The contract's problem type for each refusal. */
export const PROBLEM_TYPE: Readonly<Record<RefusalKind, string>> = {
  'illegal-transition': '/problems/illegal-lifecycle-transition',
  'not-permitted': '/problems/forbidden',
  'precondition-unmet': '/problems/precondition-unmet',
  'stale-version': '/problems/precondition-failed',
};

/** Plain language for each precondition, shown to whoever hit it. */
export const PRECONDITION_MESSAGE: Readonly<Record<Precondition, string>> = {
  'identity-document-verified':
    'The identity document on this application has not been verified yet.',
  'required-documents-present':
    'Some required documents are missing or have not cleared scanning.',
  'all-instructions-resolved':
    'There are unresolved items on the Letter of Instruction. Respond to all of them before resubmitting.',
  'order-of-payment-issued':
    'No Order of Payment has been issued for this application, so there is nothing to pay.',
  'payment-proof-submitted':
    'No proof of payment has been submitted.',
  'payment-verified':
    'The payment on this application has not been verified by the Treasurer’s Office.',
  'evaluations-complete':
    'Not every evaluation stage has been completed.',
  'permit-generated':
    'No permit has been generated for this application yet.',
};
