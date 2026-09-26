import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../common/problem/problem';
import { PRECONDITION_MESSAGE, PROBLEM_TYPE, Refusal } from '../domain/lifecycle-errors';

/**
 * A refusal, translated without losing which kind it was.
 *
 * Shared by every transport that calls `LifecycleService.transition()` —
 * originally the staff transitions route, now also the citizen-facing
 * cancel/submit-draft routes. The distinction matters to whoever hit it:
 * "you may not do this", "this application is not ready for that yet", and
 * "someone else changed it while you were reading" require three different
 * next actions, and collapsing them into one 400 makes all three look like
 * a bug in the app.
 *
 * The problem type and the plain-language text come from the domain's own
 * tables rather than from strings written here. A second wording of "you
 * have not paid yet" is a second thing to keep in step with the first, and
 * the one that drifts is always the one the applicant reads.
 */
export function refusalToProblem(refusal: Refusal): ProblemException {
  switch (refusal.kind) {
    case 'not-permitted':
      return new ProblemException(
        PROBLEM_TYPE['not-permitted'], 'Not permitted', HttpStatus.FORBIDDEN,
        refusal.reason === 'wrong-actor'
          ? 'This move is not one this kind of account may make.'
          : refusal.reason === 'wrong-stage'
            ? `This application is at the ${refusal.stage ?? 'current'} evaluation stage, which is not assigned to `
              + 'your account. The officer who holds that stage decides it.'
            : 'This account does not hold the permission this action requires.',
      );

    case 'illegal-transition':
      return new ProblemException(
        PROBLEM_TYPE['illegal-transition'],
        'The resource is not in a state that permits this',
        HttpStatus.CONFLICT,
        refusal.legalMoves.length === 0
          ? `${refusal.from} is a final status; nothing follows it.`
          : `An application at ${refusal.from} cannot move to ${refusal.to}. It can move to: ${refusal.legalMoves.join(', ')}.`,
      );

    case 'precondition-unmet': {
      // Every unmet precondition, not the first — someone told to fix one
      // thing, who fixes it and is then told about the next, learns to
      // distrust the message. `order-of-payment-issued` is the one
      // exception: since AssessmentService.issue() itself now refuses to
      // issue an Order before every evaluation stage has passed, nobody can
      // act on "no Order of Payment" until `evaluations-complete` is
      // already true — reporting it alongside an incomplete evaluation
      // doesn't name a second thing to fix, it names a step that is not
      // reachable yet, which is exactly the noise this rule exists to avoid.
      const reportable = refusal.unmet.includes('evaluations-complete')
        ? refusal.unmet.filter((precondition) => precondition !== 'order-of-payment-issued')
        : refusal.unmet;
      return new ProblemException(
        PROBLEM_TYPE['precondition-unmet'], 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
        reportable.map((precondition) => PRECONDITION_MESSAGE[precondition]).join(' '),
      );
    }

    case 'stale-version':
      return new ProblemException(
        PROBLEM_TYPE['stale-version'], 'The resource has changed', HttpStatus.PRECONDITION_FAILED,
        'Someone else changed this application while it was open. Reload it and look again before acting: '
        + 'the decision you were about to make may no longer be the right one.',
      );
  }
}
