import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../../applications/domain/application';

/**
 * The document at the end of the whole process.
 *
 * Until now the lifecycle could move an application to **Permit Generated**
 * with `preconditions: []` — nothing checked that a permit existed. The
 * applicant was notified their permit had been generated, and there was no
 * permit. That is the same class of failure as showing a queued submission as
 * submitted, and it is worse here because the applicant may travel to a counter
 * on the strength of it.
 *
 * So generation happens through this service, and the transition to Permit
 * Generated now carries the `permit-generated` precondition. The order is:
 * generate the permit, then move the status. Not the reverse.
 */

export type GenerateResult =
  | { readonly ok: true; readonly permitNumber: string; readonly issuedDate: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-approved' | 'already-generated' | 'invalid';
      readonly detail: string;
    };

export type PrepareReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'no-permit' | 'invalid'; readonly detail: string };

export type ReleaseResult =
  | { readonly ok: true; readonly releasedAt: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-ready' | 'already-released' | 'invalid';
      readonly detail: string;
    };

export type ReleaseMethod = 'Physical Claim' | 'Authorized Representative';

export class PermitService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * Issues the permit number and records what was permitted.
   *
   * Requires the application to be **Approved**. Generating a permit for an
   * application that has not been approved produces a document that says the
   * Building Official allowed something they never saw.
   *
   * The number is issued inside the transaction from a per-year sequence, so
   * two officers approving at the same moment cannot be handed the same one.
   * A duplicate permit number is not a display bug: it is two buildings whose
   * paperwork cannot be told apart.
   */
  async generate(options: {
    applicationId: string;
    officer: Caller;
    scope: string;
    conditions: readonly string[];
  }): Promise<GenerateResult> {
    const { applicationId, officer, scope, conditions } = options;

    if (scope.trim().length < 10) {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'The permit must state what it permits, specifically enough to be checked on site.',
      };
    }

    return this.db.transaction(async (tx) => {
      const application = await tx.query<{ lifecycle_status: string; permit_type: string }>(
        'select lifecycle_status, permit_type from applications where id = $1 for update',
        [applicationId],
      );
      const row = application.rows[0];
      if (row === undefined) return { ok: false, reason: 'not-found', detail: 'no such application' };
      if (row.lifecycle_status !== 'Approved') {
        return {
          ok: false,
          reason: 'not-approved',
          detail: `A permit can only be generated for an approved application. This one is ${row.lifecycle_status}.`,
        };
      }

      const existing = await tx.query('select 1 from generated_permits where application_id = $1', [applicationId]);
      if (existing.rows.length > 0) {
        return {
          ok: false,
          reason: 'already-generated',
          detail: 'A permit has already been generated for this application.',
        };
      }

      const issuedDate = this.clock();
      const year = issuedDate.getUTCFullYear();
      const prefix = PERMIT_NUMBER_PREFIXES[row.permit_type] ?? FALLBACK_PREFIX;

      // A single statement, so PostgreSQL serialises it on the primary key and
      // there is no window between reading the counter and incrementing it.
      //
      // The first version of this counted existing permits and added one. That
      // collides the moment a number in the table did not come from the counter
      // -- a migrated record, a hand-corrected one -- and the sample emitter
      // proved it by issuing FP-2026-000002 into a fixture that already held
      // FP-2026-000212. It was also not concurrency-safe: the row lock held
      // above is on `applications`, and two applications take two locks.
      const sequence = await tx.query<{ last_issued: number }>(
        `insert into document_number_sequences (series, year, last_issued)
         values ($1, $2, 1)
         on conflict (series, year)
           do update set last_issued = document_number_sequences.last_issued + 1
         returning last_issued`,
        [prefix, year],
      );
      const next = Number(sequence.rows[0]?.last_issued ?? 1);
      const permitNumber = `${prefix}-${year}-${String(next).padStart(6, '0')}`;

      await tx.query(
        `insert into generated_permits (application_id, permit_number, issued_date, scope, conditions, generated_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [applicationId, permitNumber, issuedDate, scope.trim(),
         conditions.map((c) => c.trim()).filter((c) => c.length > 0), officer.accountId],
      );

      await this.audit.append({
        action: 'permit.generated',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        afterState: { permitNumber, scope: scope.trim(), conditions },
      }, tx);

      return { ok: true, permitNumber, issuedDate: issuedDate.toISOString() };
    });
  }

  /**
   * Records where and when the applicant may collect, and what to bring.
   *
   * Separate from the release itself because it happens earlier and by a
   * different person, and because an applicant needs it BEFORE they travel.
   * Nothing here is invented: the claim location and office hours are the LGU's
   * (M-11), and a guess sends someone to the wrong counter.
   */
  async prepareRelease(options: {
    applicationId: string;
    officer: Caller;
    claimLocation: string;
    officeHours: string;
    bringWithYou: readonly string[];
  }): Promise<PrepareReleaseResult> {
    const { applicationId, officer, claimLocation, officeHours, bringWithYou } = options;

    if (claimLocation.trim() === '' || officeHours.trim() === '') {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'An applicant needs a place and a time before they travel. Neither may be blank.',
      };
    }

    return this.db.transaction(async (tx) => {
      const permit = await tx.query('select 1 from generated_permits where application_id = $1', [applicationId]);
      if (permit.rows.length === 0) {
        return { ok: false, reason: 'no-permit', detail: 'No permit has been generated for this application.' };
      }

      await tx.query(
        `insert into permit_releases (application_id, status, claim_location, office_hours, bring_with_you)
         values ($1,'Ready for Release',$2,$3,$4)
         on conflict (application_id) do update
            set claim_location = excluded.claim_location,
                office_hours = excluded.office_hours,
                bring_with_you = excluded.bring_with_you`,
        [applicationId, claimLocation.trim(), officeHours.trim(),
         bringWithYou.map((item) => item.trim()).filter((item) => item.length > 0)],
      );

      await this.audit.append({
        action: 'permit.release-prepared',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
      }, tx);

      return { ok: true };
    });
  }

  /**
   * The moment the permit leaves the LGU's hands.
   *
   * The claimant's name is recorded because it is the only evidence of who
   * actually took the document — and "Authorized Representative" without a name
   * is a permit handed to nobody in particular. Released once: a second release
   * of the same permit means two people are holding what should be one
   * document.
   */
  async release(options: {
    applicationId: string;
    officer: Caller;
    claimantName: string;
    method: ReleaseMethod;
  }): Promise<ReleaseResult> {
    const { applicationId, officer, claimantName, method } = options;

    if (claimantName.trim().length < 2) {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'Record who collected the permit. It is the only evidence of who holds it.',
      };
    }

    return this.db.transaction(async (tx) => {
      const application = await tx.query<{ lifecycle_status: string }>(
        'select lifecycle_status from applications where id = $1 for update',
        [applicationId],
      );
      const row = application.rows[0];
      if (row === undefined) return { ok: false, reason: 'not-found', detail: 'no such application' };
      if (row.lifecycle_status !== 'Ready for Release') {
        return {
          ok: false,
          reason: 'not-ready',
          detail: `This application is ${row.lifecycle_status}, not Ready for Release.`,
        };
      }

      const release = await tx.query<{ released_at: Date | null }>(
        'select released_at from permit_releases where application_id = $1 for update',
        [applicationId],
      );
      if (release.rows.length === 0) {
        return { ok: false, reason: 'not-ready', detail: 'No release has been prepared for this application.' };
      }
      if (release.rows[0]?.released_at !== null) {
        return { ok: false, reason: 'already-released', detail: 'This permit has already been released.' };
      }

      const releasedAt = this.clock();
      await tx.query(
        `update permit_releases
            set status = 'Released', method = $1, claimant_name = $2,
                releasing_officer = $3, released_at = $4
          where application_id = $5`,
        [method, claimantName.trim(), officer.accountId, releasedAt, applicationId],
      );

      await this.audit.append({
        action: 'permit.released',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: officer.accountId,
        afterState: { claimantName: claimantName.trim(), method },
      }, tx);

      return { ok: true, releasedAt: releasedAt.toISOString() };
    });
  }
}

/**
 * The permit number's prefix, by permit type.
 *
 * An applicant reads this number aloud at a counter and writes it on a form. A
 * prefix that says what kind of permit it is makes a misfiled one obvious; an
 * opaque serial does not.
 *
 * The keys are the permit types in `permit_types` (migration 002), verbatim.
 * The first version of this table invented names — "Building Permit",
 * "Occupancy Permit" — that the reference table does not have, so every real
 * application would have fallen through to the generic prefix and no test would
 * have said so. A standing test now asserts every seeded permit type appears
 * here.
 *
 * An unknown type still falls back rather than failing: a permit type the LGU
 * adds must not stop a permit being issued while someone updates this file.
 */
export const PERMIT_NUMBER_PREFIXES: Readonly<Record<string, string>> = {
  'New Construction': 'BP',
  Renovation: 'RNV',
  'Addition/Extension': 'ADD',
  Demolition: 'DMP',
  Architectural: 'ARP',
  'Civil/Structural': 'CSP',
  Electrical: 'ELP',
  Mechanical: 'MEP',
  'Sanitary/Plumbing': 'SPP',
  Plumbing: 'PLP',
  Electronics: 'ECP',
  'Interior Design': 'IDP',
  Fencing: 'FP',
  Sign: 'SGP',
  Excavation: 'EXP',
  'Certificate of Occupancy': 'COO',
  'Business Permit': 'BSP',
};

/** What an unrecognised permit type gets. Deliberately not a failure. */
export const FALLBACK_PREFIX = 'PRM';
