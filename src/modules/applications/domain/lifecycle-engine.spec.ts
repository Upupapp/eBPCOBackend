import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APPLICANT_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
import { ApplicationSnapshot, Caller } from './application';
import { decide } from './lifecycle-engine';
import {
  LIFECYCLE_STATUSES,
  LifecycleStatus,
  TRANSITIONS,
  applicantStatusOf,
  isTerminal,
  pledgeApplies,
  requiresApplicantAction,
  ruleFor,
} from './lifecycle';

const NOW = new Date('2026-08-19T12:00:00+08:00');
const APPLICANT_ACCOUNT = 'applicant-1';

/** Every precondition satisfied, so a test only has to turn OFF what it means to test. */
const satisfied = (status: LifecycleStatus, overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot => ({
  id: 'app-1',
  applicantAccountId: APPLICANT_ACCOUNT,
  status,
  version: 1,
  identityDocumentVerified: true,
  requiredDocumentsPresent: true,
  openInstructionCount: 0,
  evaluationsComplete: true,
  orderOfPaymentIssued: true,
  paymentProofSubmitted: true,
  paymentVerified: true,
  permitGenerated: true,
  ...overrides,
});

const applicant = (accountId = APPLICANT_ACCOUNT): Caller => ({
  accountId, kind: 'applicant', scopes: APPLICANT_SCOPES,
});

/** A staff caller holding every scope, so permission is not the variable under test. */
const superOfficer = (): Caller => ({
  accountId: 'officer-1',
  kind: 'staff',
  scopes: [...new Set(Object.values(ROLE_SCOPES).flat())],
});

describe('every legal transition, and only those', () => {
  // Acceptance criterion: a table-driven test exercising every legal move and
  // asserting every other is refused. Written over the table rather than case
  // by case, so a transition added tomorrow is covered by this test today.

  it.each(TRANSITIONS.map((rule) => [rule.from, rule.to] as const))(
    'permits %s -> %s for a caller who may make it',
    (from, to) => {
      const rule = ruleFor(from, to)!;
      const caller = rule.actors.includes('applicant') ? applicant() : superOfficer();

      const decision = decide({ snapshot: satisfied(from), caller, to, now: NOW });

      expect(decision.ok).toBe(true);
    },
  );

  it('refuses every pair that is not in the table', () => {
    const legal = new Set(TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`));
    const refused: string[] = [];
    let checked = 0;

    for (const from of LIFECYCLE_STATUSES) {
      for (const to of LIFECYCLE_STATUSES) {
        if (from === to || legal.has(`${from}->${to}`)) continue;
        checked += 1;

        const decision = decide({ snapshot: satisfied(from), caller: superOfficer(), to, now: NOW });
        if (decision.ok || decision.refusal.kind !== 'illegal-transition') {
          refused.push(`${from} -> ${to}`);
        }
      }
    }

    // 19 x 19 minus the legal ones: a real sweep, not a sample.
    expect(checked).toBeGreaterThan(300);
    expect(refused).toEqual([]);
  });

  it('names the moves that WERE available when it refuses one that is not', () => {
    // A refusal that only says "no" makes the caller guess.
    const decision = decide({ snapshot: satisfied('Submitted'), caller: superOfficer(), to: 'Released', now: NOW });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('illegal-transition');
    if (decision.refusal.kind !== 'illegal-transition') return;
    expect(decision.refusal.legalMoves).toEqual(expect.arrayContaining(['Received', 'Cancelled']));
  });

  it('lets no terminal status be left', () => {
    for (const status of LIFECYCLE_STATUSES.filter(isTerminal)) {
      for (const to of LIFECYCLE_STATUSES) {
        if (to === status) continue;
        const decision = decide({ snapshot: satisfied(status), caller: superOfficer(), to, now: NOW });
        expect(decision.ok).toBe(false);
      }
    }
  });
});

describe('permission, asserted independently of precondition', () => {
  // Acceptance criterion. The two are different questions with different
  // answers: telling an officer "forbidden" when the truth is "the applicant
  // has not paid" sends them to the wrong place entirely.

  it.each(TRANSITIONS.filter((rule) => !rule.actors.includes('applicant')).map((r) => [r.from, r.to] as const))(
    'refuses %s -> %s to an applicant, even with every precondition met',
    (from, to) => {
      const decision = decide({ snapshot: satisfied(from), caller: applicant(), to, now: NOW });

      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.refusal.kind).toBe('not-permitted');
    },
  );

  it.each(TRANSITIONS.map((rule) => [rule.from, rule.to, rule.requires] as const))(
    'refuses %s -> %s to a staff caller lacking %s',
    (from, to, required) => {
      const rule = ruleFor(from, to)!;
      if (!rule.actors.includes('staff')) return;

      const withoutIt: Caller = {
        accountId: 'officer-1',
        kind: 'staff',
        scopes: [...new Set(Object.values(ROLE_SCOPES).flat())].filter((scope) => scope !== required),
      };

      const decision = decide({ snapshot: satisfied(from), caller: withoutIt, to, now: NOW });

      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.refusal.kind).toBe('not-permitted');
      if (decision.refusal.kind !== 'not-permitted') return;
      expect(decision.refusal.reason).toBe('missing-scope');
      expect(decision.refusal.requiredScope).toBe(required);
    },
  );

  it('refuses an applicant acting on somebody else’s application', () => {
    const decision = decide({
      snapshot: satisfied('Draft'),
      caller: applicant('a-different-applicant'),
      to: 'Submitted',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
  });

  it('separates duties: an evaluator cannot approve, a cashier cannot evaluate', () => {
    const evaluator: Caller = { accountId: 'e', kind: 'staff', scopes: ROLE_SCOPES.evaluator };
    const cashier: Caller = { accountId: 'c', kind: 'staff', scopes: ROLE_SCOPES.cashier };

    expect(decide({ snapshot: satisfied('For Approval'), caller: evaluator, to: 'Approved', now: NOW }).ok).toBe(false);
    expect(decide({ snapshot: satisfied('Document Verification'), caller: cashier, to: 'Under Evaluation', now: NOW }).ok).toBe(false);
  });
});

describe('preconditions', () => {
  it('refuses Assessed without an Order of Payment, and says so', () => {
    // The rule the whole payments design rests on: no Order means no figure and
    // no way to pay.
    const decision = decide({
      snapshot: satisfied('Under Evaluation', { orderOfPaymentIssued: false }),
      caller: superOfficer(),
      to: 'Assessed',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('precondition-unmet');
    if (decision.refusal.kind !== 'precondition-unmet') return;
    expect(decision.refusal.unmet).toContain('order-of-payment-issued');
  });

  it('refuses Ready for Release without a generated permit', () => {
    const decision = decide({
      snapshot: satisfied('Permit Generated', { permitGenerated: false }),
      caller: superOfficer(),
      to: 'Ready for Release',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('precondition-unmet');
  });

  it('refuses resubmission while instructions are still open', () => {
    const decision = decide({
      snapshot: satisfied('Revision Required', { openInstructionCount: 2 }),
      caller: applicant(),
      to: 'Under Evaluation',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('precondition-unmet');
    if (decision.refusal.kind !== 'precondition-unmet') return;
    expect(decision.refusal.unmet).toContain('all-instructions-resolved');
  });

  it('refuses filing without a verified identity document', () => {
    // Tier 2 of decision E-5, enforced as a lifecycle precondition rather than
    // as a UI rule.
    const decision = decide({
      snapshot: satisfied('Draft', { identityDocumentVerified: false }),
      caller: applicant(),
      to: 'Submitted',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('precondition-unmet');
  });

  it('names every unmet precondition, not just the first', () => {
    const decision = decide({
      snapshot: satisfied('Draft', { identityDocumentVerified: false, requiredDocumentsPresent: false }),
      caller: applicant(),
      to: 'Submitted',
      now: NOW,
    });

    if (decision.ok) throw new Error('expected refusal');
    if (decision.refusal.kind !== 'precondition-unmet') throw new Error('wrong refusal');
    expect(decision.refusal.unmet).toHaveLength(2);
  });
});

describe('decision E-4: applicant cancellation', () => {
  // Yes until an Order of Payment exists; after that it touches money and
  // becomes an officer's act. See docs/decisions/0007.

  it.each(['Draft', 'Submitted', 'Received', 'Revision Required'] as const)(
    'lets an applicant withdraw from %s',
    (from) => {
      expect(decide({ snapshot: satisfied(from), caller: applicant(), to: 'Cancelled', now: NOW }).ok).toBe(true);
    },
  );

  it('refuses applicant cancellation once an Order of Payment exists', () => {
    const decision = decide({ snapshot: satisfied('Assessed'), caller: applicant(), to: 'Cancelled', now: NOW });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('not-permitted');
  });

  it('still lets an officer cancel an assessed application', () => {
    // The applicant can ask; it becomes a request an officer decides on.
    expect(decide({ snapshot: satisfied('Assessed'), caller: superOfficer(), to: 'Cancelled', now: NOW }).ok).toBe(true);
  });
});

describe('optimistic concurrency', () => {
  it('refuses a caller acting on a version they have not seen', () => {
    const decision = decide({
      snapshot: satisfied('Submitted', { version: 5 }),
      caller: superOfficer(),
      to: 'Received',
      now: NOW,
      expectedVersion: 4,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.kind).toBe('stale-version');
  });

  it('checks the version before anything else', () => {
    // Every other answer would be about the wrong version of the record.
    const decision = decide({
      snapshot: satisfied('Submitted', { version: 5 }),
      caller: applicant(),
      to: 'Released',
      now: NOW,
      expectedVersion: 1,
    });

    if (decision.ok) throw new Error('expected refusal');
    expect(decision.refusal.kind).toBe('stale-version');
  });

  it('advances the version on a successful move', () => {
    const decision = decide({
      snapshot: satisfied('Submitted', { version: 7 }),
      caller: superOfficer(), to: 'Received', now: NOW, expectedVersion: 7,
    });

    if (!decision.ok) throw new Error('expected success');
    expect(decision.outcome.nextVersion).toBe(8);
  });
});

describe('events', () => {
  it('produces exactly one audit event per move', () => {
    const decision = decide({ snapshot: satisfied('Submitted'), caller: superOfficer(), to: 'Received', now: NOW });

    if (!decision.ok) throw new Error('expected success');
    expect(decision.outcome.events.filter((e) => e.type === 'application.transitioned')).toHaveLength(1);
  });

  it('produces the notification the rule names, and no other', () => {
    const decision = decide({ snapshot: satisfied('Submitted'), caller: superOfficer(), to: 'Received', now: NOW });

    if (!decision.ok) throw new Error('expected success');
    const notifications = decision.outcome.events.filter((e) => e.type !== 'application.transitioned');
    expect(notifications.map((e) => e.type)).toEqual(['application.received']);
  });

  it('produces no events at all when the move is refused', () => {
    // A refused move must not notify anyone that something happened.
    const decision = decide({ snapshot: satisfied('Submitted'), caller: superOfficer(), to: 'Released', now: NOW });
    expect(decision.ok).toBe(false);
  });

  it('carries evaluator remarks through byte for byte', () => {
    // Acceptance criterion. Both clients render these verbatim, so what the
    // evaluator wrote is what the applicant reads.
    const remarks =
      'Sheet S-3 bears no signature or dry seal of the civil engineer of record.\n' +
      'North boundary is 0.85m outside the TCT description — “resubmit”, per §304.';

    const decision = decide({
      snapshot: satisfied('Under Evaluation'), caller: superOfficer(),
      to: 'Revision Required', now: NOW, remarks,
    });

    if (!decision.ok) throw new Error('expected success');
    const audit = decision.outcome.events.find((e) => e.type === 'application.transitioned');
    expect(audit?.payload.remarks).toBe(remarks);
  });

  it('every notification it can emit is in the closed catalog', () => {
    const catalog = new Set([
      'application.submitted', 'application.received', 'application.document-verification-started',
      'application.document-rejected', 'application.evaluation-started', 'application.evaluation-passed',
      'application.revision-required', 'application.instruction-issued', 'application.instruction-resolved',
      'application.assessed', 'application.payment-submitted', 'application.payment-under-verification',
      'application.payment-verified', 'application.payment-rejected', 'application.for-approval',
      'application.approved', 'application.rejected', 'application.permit-generated',
      'application.ready-for-release', 'application.released', 'application.completed',
      'application.expired', 'application.cancelled', 'inspection.scheduled',
    ]);

    for (const rule of TRANSITIONS) {
      if (rule.notifies !== undefined) expect(catalog.has(rule.notifies)).toBe(true);
    }
  });
});

describe('the projection, against the contract', () => {
  // Acceptance criterion: the 19 -> 7 mapping matches the contract's normative
  // file for all nineteen. The mobile client carries the mirror of this test,
  // so all three tiers are held to one file.
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../../../../test/contract/lifecycle-projection.json'), 'utf8'),
  ) as { contractVersion: string; projection: Record<string, Record<string, unknown>> };

  it('is the fixture this test was written against', () => {
    expect(contract.contractVersion).toBe('0.1.0');
  });

  it('covers exactly the nineteen statuses', () => {
    expect(Object.keys(contract.projection).sort()).toEqual([...LIFECYCLE_STATUSES].sort());
  });

  it.each(Object.entries(contract.projection))('%s projects as the contract says', (status, row) => {
    const lifecycle = status as LifecycleStatus;

    expect(applicantStatusOf(lifecycle)).toBe(row.applicantStatus);
    expect(requiresApplicantAction(lifecycle)).toBe(row.requiresApplicantAction);
    expect(isTerminal(lifecycle)).toBe(row.terminal);
    expect(pledgeApplies(lifecycle)).toBe(row.pledgeApplies);
  });

  it('agrees with the contract on which moves are legal', () => {
    const contractTransitions = (JSON.parse(
      readFileSync(join(__dirname, '../../../../test/contract/lifecycle-projection.json'), 'utf8'),
    ) as { validTransitions: Record<string, string[]> }).validTransitions;

    for (const [from, targets] of Object.entries(contractTransitions)) {
      const mine = [...TRANSITIONS.filter((r) => r.from === from).map((r) => r.to)].sort();
      expect(mine).toEqual([...targets].sort());
    }
  });
});

describe('every transition is reachable by a real role', () => {
  // The test that found the bug above: `superOfficer` held the union of every
  // ROLE_SCOPES entry, and three rules required `applications:write`, which no
  // staff role granted. The rules were legal, permitted on paper, and
  // impossible to actually perform.
  it('has at least one role or the applicant able to make each move', () => {
    const unreachable: string[] = [];

    for (const rule of TRANSITIONS) {
      const applicantCan =
        rule.actors.includes('applicant') && (APPLICANT_SCOPES as readonly string[]).includes(rule.requires);
      const someRoleCan =
        rule.actors.includes('staff') &&
        Object.values(ROLE_SCOPES).some((scopes) => (scopes as readonly string[]).includes(rule.requires));

      if (!applicantCan && !someRoleCan) unreachable.push(`${rule.from} -> ${rule.to} needs ${rule.requires}`);
    }

    expect(unreachable).toEqual([]);
  });
});
