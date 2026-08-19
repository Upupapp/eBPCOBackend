import { ApplicationRecord, toApplicantView } from './applicant-view';

const record = (overrides: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  id: 'app-1',
  referenceNumber: 'BP-2026-000418',
  permitType: 'Fencing',
  serviceDomain: 'Construction Permit',
  applicationAction: 'New',
  lifecycleStatus: 'Under Evaluation',
  businessId: null,
  businessName: null,
  location: 'Lot 7 Block 3, Barangay Bagumbayan',
  classification: null,
  pledgedWorkingDays: null,
  pledgeDueDate: null,
  pledgeApproximate: false,
  pledgeSuspendedSince: null,
  dateSubmitted: new Date('2026-08-17T09:14:00Z'),
  updatedAt: new Date('2026-08-19T11:02:00Z'),
  openInstructionCount: 0,
  orderOfPayment: null,
  officer: 'Engr. Dela Cruz',
  applicantName: 'Maria Santos',
  evaluationStage: 'Zoning',
  ...overrides,
});

describe('no assessment means no amount, anywhere', () => {
  // Acceptance criterion. An estimate on a government fee screen is a
  // misrepresentation, and a zero is worse -- it reads as "nothing to pay".

  it('omits the Order of Payment entirely when none has been issued', () => {
    const view = toApplicantView(record());

    expect(view.payment).toEqual({ status: 'Not Yet Available' });
    expect(view.payment).not.toHaveProperty('orderOfPayment');
  });

  it('emits no monetary value anywhere in the payload', () => {
    // Scanned rather than asserted field by field, so a fee added to the view
    // later is caught by this test rather than by an applicant.
    const serialised = JSON.stringify(toApplicantView(record()));

    expect(serialised).not.toMatch(/centavos/i);
    expect(serialised).not.toMatch(/"total"/i);
    expect(serialised).not.toMatch(/\bamount\b/i);
  });

  it('never emits a zero total as a stand-in for "not assessed"', () => {
    const view = toApplicantView(record()) as { payment: Record<string, unknown> };

    expect(view.payment.totalCentavos).toBeUndefined();
    expect(Object.values(view.payment)).not.toContain(0);
  });

  it('emits the figures once an Order of Payment exists', () => {
    const view = toApplicantView(
      record({
        orderOfPayment: {
          number: 'OP-2026-001127',
          assessedAt: new Date('2026-08-19T11:02:00Z'),
          dueDate: '2026-09-18',
          feeScheduleVersion: '2026.1',
          filingCentavos: 50_000,
          processingCentavos: 120_000,
          architecturalCentavos: 384_500,
          structuralCentavos: 512_000,
          electricalCentavos: 165_000,
          othersCentavos: 28_750,
          totalCentavos: 1_260_250,
        },
      }),
    ) as { payment: { orderOfPayment: { totalCentavos: number; fees: Record<string, number> } } };

    expect(view.payment.orderOfPayment.totalCentavos).toBe(1_260_250);
    expect(Object.values(view.payment.orderOfPayment.fees).reduce((a, b) => a + b, 0)).toBe(1_260_250);
  });
});

describe('no classification means no countdown', () => {
  it('omits the pledge when the charter has no entry', () => {
    const view = toApplicantView(record());

    expect(view).not.toHaveProperty('pledge');
    expect(view).not.toHaveProperty('classification');
  });

  it('emits the pledge once the application is classified', () => {
    const view = toApplicantView(
      record({ classification: 'Complex', pledgedWorkingDays: 7, pledgeDueDate: '2026-08-28' }),
    ) as { pledge: Record<string, unknown> };

    expect(view.pledge).toMatchObject({ pledgedWorkingDays: 7, dueDate: '2026-08-28', suspended: false });
  });

  it('reports the clock as suspended while the applicant holds a deficiency', () => {
    const view = toApplicantView(
      record({
        lifecycleStatus: 'Revision Required',
        classification: 'Simple',
        pledgedWorkingDays: 3,
        pledgeSuspendedSince: new Date('2026-08-18T16:20:00Z'),
      }),
    ) as { pledge: Record<string, unknown> };

    expect(view.pledge.suspended).toBe(true);
    expect(view.pledge.suspendedSince).toBe('2026-08-18T16:20:00.000Z');
  });

  it('marks a pledge approximate when the holiday calendar is incomplete', () => {
    const view = toApplicantView(
      record({ classification: 'Simple', pledgedWorkingDays: 3, pledgeApproximate: true }),
    ) as { pledge: Record<string, unknown> };

    expect(view.pledge.approximate).toBe(true);
  });
});

describe('officer-scope fields never reach an applicant', () => {
  it('omits the assigned officer', () => {
    // RA 11032's zero-contact policy exists to remove direct applicant-officer
    // contact; publishing who is handling a file invites what it forbids.
    const serialised = JSON.stringify(toApplicantView(record()));

    expect(serialised).not.toContain('Dela Cruz');
    expect(serialised).not.toMatch(/"officer"/);
  });

  it('omits the internal evaluation stage', () => {
    const view = toApplicantView(record());

    expect(view).not.toHaveProperty('evaluationStage');
  });

  it('is built by whitelisting, so a new record field is not published by default', () => {
    const withSecret = { ...record(), internalRiskScore: 91, officerNotes: 'watch this one' };
    const serialised = JSON.stringify(toApplicantView(withSecret));

    expect(serialised).not.toContain('internalRiskScore');
    expect(serialised).not.toContain('watch this one');
  });
});

describe('the projection is computed here, not by the client', () => {
  it('returns the applicant status alongside the lifecycle status', () => {
    const view = toApplicantView(record({ lifecycleStatus: 'Assessed' }));

    expect(view.lifecycleStatus).toBe('Assessed');
    expect(view.applicantStatus).toBe('Payment Verification');
  });

  it('flags that the applicant is the one holding it up, even under a passive headline', () => {
    // 'Assessed' reads as "Payment Verification", which gives the applicant no
    // hint they owe an act.
    const view = toApplicantView(record({ lifecycleStatus: 'Assessed' }));

    expect(view.applicantStatus).toBe('Payment Verification');
    expect(view.requiresApplicantAction).toBe(true);
  });
});
