import { LifecycleStatus } from '../../applications/domain/lifecycle';

/**
 * The closed list of things the LGU says to its own officers.
 *
 * Closed for the same reason the applicant catalogue is: an improvised message
 * cannot be accounted for afterwards. Deliberately small -- three entries --
 * because a staff inbox that fills with progress reports is one nobody reads,
 * and the point of D-7 was to build a worklist rather than a feed.
 */

export interface StaffNoticeType {
  readonly type: string;
  /** Whether an act is owed. Not a priority; a priority would be a judgement. */
  readonly requiresAct: boolean;
}

export const STAFF_NOTICE_TYPES: readonly StaffNoticeType[] = [
  { type: 'application-awaiting-you', requiresAct: true },
  { type: 'assessment-overdue', requiresAct: true },
  { type: 'workflow-changed', requiresAct: false },
];

export interface StaffNotice {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string | null;
}

/**
 * Names the reference, not the applicant.
 *
 * An officer's worklist is not a place to restate a citizen's name, address or
 * business: it is read all day, over shoulders, on a shared screen at a counter.
 * The reference number is enough to open the record, and opening the record is
 * where the access is checked and logged.
 */
export function awaitingYou(
  reference: string, status: LifecycleStatus, applicationId: string,
): StaffNotice {
  return {
    type: 'application-awaiting-you',
    title: `${reference} is waiting`,
    body: `Application ${reference} is at ${status} and is waiting for your action.`,
    deepLink: `/staff/applications/${applicationId}`,
  };
}

/**
 * An Order of Payment has fallen due with nothing paid against it.
 *
 * Names the Order number rather than the applicant, same as `awaitingYou`: a
 * worklist is read at a counter on a shared screen, and the reference is enough
 * to open the record where access is checked and logged.
 *
 * Says what is true and NOT what to do about it. The sweep deliberately does
 * not expire the application -- ending someone's application because a date
 * passed while nobody looked is a decision the LGU takes -- and a notice
 * instructing an officer to expire it would make the cron entry that decision
 * by another route.
 */
export function assessmentOverdue(
  orderNumber: string, reference: string, applicationId: string,
): StaffNotice {
  return {
    type: 'assessment-overdue',
    title: `${orderNumber} is overdue`,
    body: `Order of Payment ${orderNumber} on application ${reference} passed its due date `
      + 'with nothing paid against it. The applicant has been told.',
    deepLink: `/staff/applications/${applicationId}`,
  };
}

export function workflowChanged(): StaffNotice {
  return {
    type: 'workflow-changed',
    title: 'The application workflow changed',
    // Says THAT it changed, not what to. The change is already served in full
    // at the workflow endpoint, and a summary here would be a second account of
    // it that could disagree with the first.
    body: 'An administrator changed how applications move between statuses. '
      + 'Your queue may look different.',
    deepLink: '/staff/config/workflow',
  };
}
