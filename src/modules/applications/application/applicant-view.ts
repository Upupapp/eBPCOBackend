import {
  LifecycleStatus,
  applicantStatusOf,
  requiresApplicantAction,
} from '../domain/lifecycle';

/**
 * What an applicant is entitled to see, and nothing else.
 *
 * Built by whitelisting fields onto a fresh object rather than by deleting them
 * from the record. Deletion is the wrong shape: a field added to the record
 * later is included by default and has to be remembered about, and the thing
 * being forgotten is an officer's name or an internal evaluation stage.
 *
 * Two rules this enforces at the only place they can be enforced -- the
 * boundary where a payload is produced:
 *
 * No Order of Payment, no amount. Not zero, not an estimate, not a null field
 * that a client might render as "PHP 0.00". The key is ABSENT.
 *
 * No classification, no countdown. Where the LGU's Citizen's Charter has no
 * entry, the pledge is absent and the client says "Awaiting classification"
 * rather than asserting a deadline the LGU never promised.
 */

export interface ApplicationRecord {
  readonly id: string;
  readonly referenceNumber: string;
  readonly permitType: string;
  readonly serviceDomain: string;
  readonly applicationAction: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly location: string | null;
  readonly classification: string | null;
  readonly pledgedWorkingDays: number | null;
  readonly pledgeDueDate: string | null;
  readonly pledgeApproximate: boolean;
  readonly pledgeSuspendedSince: Date | null;
  readonly dateSubmitted: Date | null;
  readonly updatedAt: Date;
  readonly openInstructionCount: number;
  /** Present only when an officer has issued one. */
  readonly orderOfPayment: OrderOfPaymentRecord | null;
  /** Officer-scope. Never reaches an applicant payload. */
  readonly officer: string | null;
  readonly applicantName: string;
  readonly evaluationStage: string | null;
}

export interface OrderOfPaymentRecord {
  readonly number: string;
  readonly assessedAt: Date;
  readonly dueDate: string | null;
  readonly feeScheduleVersion: string;
  readonly filingCentavos: number;
  readonly processingCentavos: number;
  readonly architecturalCentavos: number;
  readonly structuralCentavos: number;
  readonly electricalCentavos: number;
  readonly othersCentavos: number;
  readonly totalCentavos: number;
}

export function toApplicantView(record: ApplicationRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: record.id,
    referenceNumber: record.referenceNumber,
    serviceDomain: record.serviceDomain,
    permitType: record.permitType,
    applicationAction: record.applicationAction,
    businessId: record.businessId,
    businessName: record.businessName,
    location: record.location,

    lifecycleStatus: record.lifecycleStatus,
    // Computed here, server-side, and returned. Neither client recomputes it.
    applicantStatus: applicantStatusOf(record.lifecycleStatus),
    requiresApplicantAction: requiresApplicantAction(record.lifecycleStatus),

    dateSubmitted: record.dateSubmitted?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
    openInstructionCount: record.openInstructionCount,
  };

  // Absent, not null: the LGU has made no pledge for a permit type its charter
  // does not cover, and a null `pledge` invites a client to render a blank
  // countdown rather than the honest "Awaiting classification".
  if (record.classification !== null && record.pledgedWorkingDays !== null) {
    view.classification = record.classification;
    view.pledge = {
      pledgedWorkingDays: record.pledgedWorkingDays,
      dueDate: record.pledgeDueDate,
      approximate: record.pledgeApproximate,
      suspended: record.pledgeSuspendedSince !== null,
      suspendedSince: record.pledgeSuspendedSince?.toISOString() ?? null,
    };
  }

  view.payment = paymentView(record.orderOfPayment);
  return view;
}

function paymentView(order: OrderOfPaymentRecord | null): Record<string, unknown> {
  if (order === null) {
    // The whole of it. No `orderOfPayment` key, no `totalCentavos`, no zero.
    return { status: 'Not Yet Available' };
  }

  return {
    status: 'Not Yet Available',
    orderOfPayment: {
      number: order.number,
      assessedAt: order.assessedAt.toISOString(),
      dueDate: order.dueDate,
      feeScheduleVersion: order.feeScheduleVersion,
      fees: {
        filing: order.filingCentavos,
        processing: order.processingCentavos,
        architectural: order.architecturalCentavos,
        structural: order.structuralCentavos,
        electrical: order.electricalCentavos,
        others: order.othersCentavos,
      },
      totalCentavos: order.totalCentavos,
    },
  };
}
