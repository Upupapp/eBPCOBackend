import { ApplicationSnapshot, Caller } from './application';
import {
  TransitionRule,
  LifecycleStatus,
  Precondition,
  legalMovesFrom,
  pledgeSuspended,
  ruleFor,
} from './lifecycle';
import { Refusal } from './lifecycle-errors';

/**
 * The decision to move an application, and nothing else.
 *
 * Pure: no database, no clock, no HTTP. It takes a snapshot, a caller and a
 * target, and returns either the events the move produces or the specific
 * reason it was refused. Everything that persists, notifies or audits happens
 * outside, driven by what this returns.
 *
 * That separation is what makes the acceptance criteria testable at all. "Every
 * legal transition is permitted and every illegal one refused" is a table-driven
 * test over a pure function; through an HTTP endpoint it would be several
 * hundred requests and a fixture per case.
 */

export interface DomainEvent {
  readonly type: string;
  readonly applicationId: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TransitionOutcome {
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  readonly nextVersion: number;
  /** True when this move stops the RA 11032 clock, false when it restarts it. */
  readonly pledgeSuspended: boolean;
  /**
   * Exactly the events this move produces: one audit event always, one
   * notification when the rule names one. Emitted by the caller inside the same
   * transaction as the status change, so a committed transition always
   * notifies and a rolled-back one never does.
   */
  readonly events: readonly DomainEvent[];
}

export type Decision =
  | { readonly ok: true; readonly outcome: TransitionOutcome }
  | { readonly ok: false; readonly refusal: Refusal };

const SATISFIES: Readonly<Record<Precondition, (snapshot: ApplicationSnapshot) => boolean>> = {
  'identity-document-verified': (s) => s.identityDocumentVerified,
  'required-documents-present': (s) => s.requiredDocumentsPresent,
  'all-instructions-resolved': (s) => s.openInstructionCount === 0,
  'order-of-payment-issued': (s) => s.orderOfPaymentIssued,
  'payment-proof-submitted': (s) => s.paymentProofSubmitted,
  'payment-verified': (s) => s.paymentVerified,
  'evaluations-complete': (s) => s.evaluationsComplete,
  'permit-generated': (s) => s.permitGenerated,
};

export interface DecideOptions {
  readonly snapshot: ApplicationSnapshot;
  readonly caller: Caller;
  readonly to: LifecycleStatus;
  readonly now: Date;
  /** The version the caller last saw. Omitted means they did not check. */
  readonly expectedVersion?: number;
  readonly remarks?: string;
  /**
   * The rules in force, passed in rather than imported.
   *
   * They became configuration under D-5, so the engine cannot reach for a
   * compiled constant any more — it would decide against a table the LGU has
   * since edited and refuse moves the database would allow. Passing them also
   * keeps this function pure, which is what makes every refusal here testable
   * without a database.
   */
  readonly rules: readonly TransitionRule[];
}

export function decide(options: DecideOptions): Decision {
  const { snapshot, caller, to, now, expectedVersion, remarks } = options;

  // Concurrency first. If the caller is acting on a record they have not seen,
  // every other answer below is about the wrong version of it.
  if (expectedVersion !== undefined && expectedVersion !== snapshot.version) {
    return {
      ok: false,
      refusal: { kind: 'stale-version', expected: expectedVersion, actual: snapshot.version },
    };
  }

  const rule = ruleFor(options.rules, snapshot.status, to);
  if (rule === undefined) {
    return {
      ok: false,
      refusal: {
        kind: 'illegal-transition',
        from: snapshot.status,
        to,
        legalMoves: legalMovesFrom(options.rules, snapshot.status),
      },
    };
  }

  // Actor kind and scope are checked separately from preconditions, and
  // reported separately: telling an officer "forbidden" when the truth is "the
  // applicant has not paid yet" sends them to the wrong place entirely.
  if (!rule.actors.includes(caller.kind)) {
    return {
      ok: false,
      refusal: {
        kind: 'not-permitted', from: snapshot.status, to,
        reason: 'wrong-actor', requiredScope: rule.requires,
      },
    };
  }

  if (!caller.scopes.includes(rule.requires)) {
    return {
      ok: false,
      refusal: {
        kind: 'not-permitted', from: snapshot.status, to,
        reason: 'missing-scope', requiredScope: rule.requires,
      },
    };
  }

  // An applicant may only ever act on their own application. Enforced here as
  // well as at the repository, because a lifecycle move is the one place where
  // acting on someone else's record does lasting damage.
  if (caller.kind === 'applicant' && caller.accountId !== snapshot.applicantAccountId) {
    return {
      ok: false,
      refusal: {
        kind: 'not-permitted', from: snapshot.status, to,
        reason: 'wrong-actor', requiredScope: rule.requires,
      },
    };
  }

  const unmet = rule.preconditions.filter((precondition) => !SATISFIES[precondition](snapshot));
  if (unmet.length > 0) {
    return { ok: false, refusal: { kind: 'precondition-unmet', from: snapshot.status, to, unmet } };
  }

  const events: DomainEvent[] = [
    {
      type: 'application.transitioned',
      applicationId: snapshot.id,
      occurredAt: now,
      payload: {
        from: snapshot.status,
        to,
        actorAccountId: caller.accountId,
        // Verbatim. Both clients render this without summarising, so what the
        // evaluator wrote is what the applicant reads.
        ...(remarks === undefined ? {} : { remarks }),
      },
    },
  ];

  if (rule.notifies !== undefined) {
    events.push({
      type: rule.notifies,
      applicationId: snapshot.id,
      occurredAt: now,
      payload: { to, applicantAccountId: snapshot.applicantAccountId },
    });
  }

  return {
    ok: true,
    outcome: {
      from: snapshot.status,
      to,
      nextVersion: snapshot.version + 1,
      pledgeSuspended: pledgeSuspended(to),
      events,
    },
  };
}
