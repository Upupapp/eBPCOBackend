/**
 * The closed catalog of things the LGU says to an applicant.
 *
 * **This is the mobile client's catalog, adopted wholesale.** An earlier
 * version of this file invented a parallel vocabulary -- twenty-four types with
 * names of my own and five categories of my own -- while the shipped app
 * already had twenty-five types with applicant-facing copy, icons, priorities,
 * and six categories the applicant can already mute in its Settings screen.
 *
 * That is exactly the drift TAB 01 exists to prevent, committed by the tier
 * that was meant to prevent it. TAB 01 reconciled the lifecycle vocabulary and
 * never compared the notification catalog, because at that point mobile's
 * notifications had no wire form at all -- the enum was never serialised. There
 * was nothing to compare against, and a vocabulary got invented into the gap.
 *
 * The resolution: the wire name is the kebab-case of the client's own enum
 * constant, mechanically, so the mapping is total and needs no judgement.
 * Categories are the client's six. `statutory` is the client's own `action`
 * priority -- it had already decided which notices require an act, and those
 * are exactly the ones whose absence costs the applicant something.
 *
 * `serverGenerated: false` marks the two the server never sends: a draft is
 * local until it is filed, and a credential expiry is computed from records the
 * applicant keeps on the device.
 */

export type NotificationCategory =
  | 'applicationUpdates'
  | 'payments'
  | 'permitStatus'
  | 'documentReminders'
  | 'appointments'
  | 'account';

export type NotificationPriority = 'action' | 'progress' | 'ambient';

export interface CatalogEntry {
  /** The wire name: kebab-case of the client's enum constant. */
  readonly type: string;
  /** The client enum constant this maps to, so the mapping is checkable. */
  readonly dartName: string;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  readonly requiresAction: boolean;
  /**
   * Missing this notice costs the applicant a right, a deadline or money.
   * Equal to the client's `action` priority, not a second judgement.
   */
  readonly statutory: boolean;
  /** False for the two the client derives locally and the server never sends. */
  readonly serverGenerated: boolean;
  /** `:applicationId` is substituted at send time. */
  readonly deepLink: string;
  readonly title: string;
  readonly body: string;
}

const APPLICATION = '/applications/:applicationId';

export const CATALOG: readonly CatalogEntry[] = [
  { type: 'application-submitted', dartName: 'applicationSubmitted', category: 'applicationUpdates', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Application filed',
    body: 'Your application has been filed and is awaiting receipt by the Office of the Building Official.' },
  { type: 'received-by-obo', dartName: 'receivedByObo', category: 'applicationUpdates', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Received by the OBO',
    body: 'The Office of the Building Official has received your application. Processing has started.' },
  { type: 'document-verification-started', dartName: 'documentVerificationStarted', category: 'documentReminders', priority: 'ambient',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Documents being checked',
    body: 'Your documents are being checked for completeness.' },
  { type: 'letter-of-instruction-issued', dartName: 'letterOfInstructionIssued', category: 'documentReminders', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/instructions`,
    title: 'Letter of Instruction issued',
    body: 'There are items to respond to before your application can continue.' },
  { type: 'evaluation-stage-passed', dartName: 'evaluationStagePassed', category: 'applicationUpdates', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Evaluation stage passed',
    body: 'An evaluation stage has been completed successfully.' },
  { type: 'revision-required', dartName: 'revisionRequired', category: 'documentReminders', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/instructions`,
    title: 'Revision required',
    body: 'The evaluator has returned items for correction. Open the Letter of Instruction to see what is required.' },
  { type: 'fsec-cleared', dartName: 'fsecCleared', category: 'applicationUpdates', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Fire Safety Evaluation Clearance issued',
    body: 'The Bureau of Fire Protection has issued your Fire Safety Evaluation Clearance.' },
  { type: 'order-of-payment-issued', dartName: 'orderOfPaymentIssued', category: 'payments', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/pay`,
    title: 'Order of Payment ready',
    body: 'Fees have been assessed. Open the application to see the breakdown and how to pay.' },
  { type: 'payment-received', dartName: 'paymentReceived', category: 'payments', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: `${APPLICATION}/pay`,
    title: 'Payment details received',
    body: 'We have your payment details and are checking them.' },
  { type: 'payment-verified', dartName: 'paymentVerified', category: 'payments', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: `${APPLICATION}/pay`,
    title: 'Payment verified',
    body: 'Your payment has been confirmed. Your application is awaiting final approval.' },
  { type: 'payment-overdue', dartName: 'paymentOverdue', category: 'payments', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/pay`,
    title: 'Payment overdue',
    body: 'The due date on your Order of Payment has passed. Open the application to see what to do.' },
  { type: 'approved', dartName: 'approved', category: 'permitStatus', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Application approved',
    body: 'Your application has been approved. Your permit is being generated.' },
  { type: 'permit-generated', dartName: 'permitGenerated', category: 'permitStatus', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: `${APPLICATION}/permit`,
    title: 'Permit generated',
    body: 'Your permit has been generated and is being prepared for release.' },
  { type: 'ready-for-release', dartName: 'readyForRelease', category: 'permitStatus', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/permit`,
    title: 'Permit ready to claim',
    body: 'Open the application to see where to claim it, when, and what to bring.' },
  { type: 'released', dartName: 'released', category: 'permitStatus', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: `${APPLICATION}/permit`,
    title: 'Permit released',
    body: 'Your permit has been released. A copy is available in the app.' },
  { type: 'rejected', dartName: 'rejected', category: 'permitStatus', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/outcome`,
    title: 'Application not approved',
    body: 'Open the application to see the reason and what options you have.' },
  { type: 'inspection-scheduled', dartName: 'inspectionScheduled', category: 'appointments', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Inspection scheduled',
    body: 'Open the application to see when, which offices are attending, and what to prepare.' },
  { type: 'appointment-reminder', dartName: 'appointmentReminder', category: 'appointments', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Appointment reminder',
    body: 'You have an appointment coming up for this application.' },
  { type: 'pledge-approaching', dartName: 'pledgeApproaching', category: 'applicationUpdates', priority: 'ambient',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Processing deadline approaching',
    body: 'The pledged processing period for this application is nearly up.' },
  { type: 'pledge-lapsed', dartName: 'pledgeLapsed', category: 'applicationUpdates', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/outcome`,
    title: 'Processing deadline passed',
    body: 'The pledged processing period for this application has passed. You may raise this with the LGU.' },
  { type: 'permit-commencement-warning', dartName: 'permitCommencementWarning', category: 'permitStatus', priority: 'action',
    requiresAction: true, statutory: true, serverGenerated: true,
    deepLink: `${APPLICATION}/permit`,
    title: 'Start work before your permit lapses',
    body: 'A building permit lapses if work does not begin within the period stated on it.' },
  { type: 'professional-credential-expiring', dartName: 'professionalCredentialExpiring', category: 'documentReminders', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: false,
    deepLink: APPLICATION,
    title: 'A professional credential is expiring',
    body: 'A PRC licence or PTR on your records is close to lapsing.' },
  { type: 'draft-idle', dartName: 'draftIdle', category: 'documentReminders', priority: 'ambient',
    requiresAction: false, statutory: false, serverGenerated: false,
    deepLink: APPLICATION,
    title: 'You have an unfinished application',
    body: 'A draft has been sitting untouched. Continue where you left off.' },
  { type: 'occupancy-now-possible', dartName: 'occupancyNowPossible', category: 'permitStatus', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: `${APPLICATION}/permit`,
    title: 'You can now apply for occupancy',
    body: 'Your construction permit is released, so a Certificate of Occupancy can now be applied for.' },
  { type: 'account-update', dartName: 'accountUpdate', category: 'account', priority: 'progress',
    requiresAction: false, statutory: false, serverGenerated: true,
    deepLink: APPLICATION,
    title: 'Account updated',
    body: 'Something changed on your account.' },
];

const BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

export function entryFor(type: string): CatalogEntry | undefined {
  return BY_TYPE.get(type);
}

export function isInCatalog(type: string): boolean {
  return BY_TYPE.has(type);
}

/** What the server may actually send. */
export const SERVER_CATALOG: readonly CatalogEntry[] = CATALOG.filter((entry) => entry.serverGenerated);

export function deepLinkFor(entry: CatalogEntry, applicationId: string): string {
  return entry.deepLink.replace(':applicationId', applicationId);
}
