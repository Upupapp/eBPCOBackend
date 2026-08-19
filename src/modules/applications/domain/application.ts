import { LifecycleStatus } from './lifecycle';

/**
 * What the engine needs to know about an application to decide a move.
 *
 * A snapshot, not the whole record: the engine asks only about facts that
 * gate a transition, so a test can construct one in three lines and a reader
 * can see the complete set of things a decision depends on.
 */
export interface ApplicationSnapshot {
  readonly id: string;
  readonly applicantAccountId: string;
  readonly status: LifecycleStatus;
  readonly version: number;

  readonly identityDocumentVerified: boolean;
  readonly requiredDocumentsPresent: boolean;
  readonly openInstructionCount: number;
  readonly evaluationsComplete: boolean;
  readonly orderOfPaymentIssued: boolean;
  readonly paymentProofSubmitted: boolean;
  readonly paymentVerified: boolean;
  readonly permitGenerated: boolean;
}

/** Who is attempting the move. */
export interface Caller {
  readonly accountId: string;
  readonly kind: 'applicant' | 'staff';
  readonly scopes: readonly string[];
}
