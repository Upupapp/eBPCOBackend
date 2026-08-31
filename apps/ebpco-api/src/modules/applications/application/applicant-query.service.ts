import { SqlClient } from '../../../persistence/sql-client';
import { CalendarRepository } from '../../compliance/application/calendar.repository';
import { Classification, computePledge } from '../../compliance/domain/pledge-clock';
import { ApplicationRecord, toApplicantView } from './applicant-view';
import { publishedNameFor } from '../../permits/domain/published-vocabulary';

/**
 * An applicant's own applications, and nothing else's.
 *
 * Scoped by `account_id` in the WHERE clause, not by a check after the fact.
 * The difference matters: a filter applied after loading is one early `return`
 * away from serving someone else's permit, and the mistake is invisible in a
 * response that looks perfectly well-formed.
 *
 * Everything leaves through `toApplicantView`, which whitelists fields onto a
 * fresh object. That is the only place the officer/applicant boundary is
 * enforced, and it has to be: a field added to the record later is included by
 * default if the boundary is a delete-list, and the thing being forgotten is an
 * officer's name or an internal evaluation stage.
 */

const RECORD_SQL = `
  select
    a.id,
    a.reference_number,
    a.permit_type,
    pt.service_domain,
    a.application_action,
    a.lifecycle_status,
    a.business_id,
    b.name as business_name,
    a.location,
    a.classification,
    a.form,
    ce.pledged_working_days,
    a.pledge_suspended_since,
    a.submitted_at,
    a.updated_at,
    (select count(*) from instruction_items ii
       join letters_of_instruction l on l.id = ii.letter_id
      where l.application_id = a.id and ii.resolved_at is null) as open_instruction_count,
    (select min(t.occurred_at) from application_transitions t
      where t.application_id = a.id and t.to_status = 'Revision Required') as suspended_from,
    (select min(t.occurred_at) from application_transitions t
      where t.application_id = a.id and t.from_status = 'Revision Required'
        and t.to_status = 'Under Evaluation') as suspended_to,
    (select max(t.occurred_at) from application_transitions t
      where t.application_id = a.id
        and t.to_status in ('Released', 'Completed', 'Rejected')) as completed_at,
    (select min(p.submitted_at) from payments p where p.application_id = a.id) as payment_submitted_at,
    (select min(p.verified_at) from payments p
      where p.application_id = a.id and p.verified_at is not null) as payment_verified_at,
    o.number as oop_number, o.assessed_at as oop_assessed_at,
    to_char(o.due_date, 'YYYY-MM-DD') as oop_due_date,
    o.fee_schedule_version as oop_version,
    o.filing_centavos, o.processing_centavos, o.architectural_centavos,
    o.structural_centavos, o.electrical_centavos, o.others_centavos, o.total_centavos
  from applications a
  join applicants ap on ap.id = a.applicant_id
  join permit_types pt on pt.permit_type = a.permit_type
  left join businesses b on b.id = a.business_id
  left join charter_entries ce on ce.id = a.charter_entry_id
  left join orders_of_payment o
    on o.application_id = a.id and o.superseded_at is null
`;

export class ApplicantQueryService {
  constructor(
    private readonly db: SqlClient,
    private readonly calendars: CalendarRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(accountId: string, limit = 50): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await this.db.query<Record<string, never>>(
      `${RECORD_SQL} where ap.account_id = $1 order by a.updated_at desc limit $2`,
      [accountId, Math.min(Math.max(limit, 1), 100)],
    );
    const calendar = await this.calendars.load();
    return (result.rows as unknown as Record<string, unknown>[])
      .map((row) => toApplicantView(this.toRecord(row, calendar)));
  }

  /**
   * One application, or null.
   *
   * Null for "no such application" and for "not yours" alike. Telling an
   * applicant that a reference exists but is not theirs confirms a neighbour
   * has applied for a permit — the same reason the staff surface answers 404
   * both ways.
   */
  async byId(accountId: string, applicationId: string): Promise<Record<string, unknown> | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(applicationId)) return null;
    const result = await this.db.query<Record<string, never>>(
      `${RECORD_SQL} where ap.account_id = $1 and a.id = $2`,
      [accountId, applicationId],
    );
    const row = (result.rows as unknown as Record<string, unknown>[])[0];
    if (row === undefined) return null;
    return toApplicantView(this.toRecord(row, await this.calendars.load()));
  }

  /**
   * The permit itself.
   *
   * C-1. The record has existed since the lifecycle could reach
   * "Permit Generated" — `generated_permits` holds the number, the issue date,
   * the scope and the conditions — and no controller read it. A citizen who
   * filed, paid and was approved could not learn their permit number, and the
   * only path to it was the RA 10173 data export: a privacy mechanism returning
   * the subject's whole record as a file, asynchronously, for a request nobody
   * makes to collect a permit.
   *
   * The conditions are the part worth carrying deliberately. They are what the
   * permit REQUIRES of the holder — a cash bond, a setback, a notice before
   * excavation — and a citizen who cannot read them cannot comply with them.
   *
   * Returns null for an application that is not theirs AND for one whose permit
   * has not been issued; the controller distinguishes the two, because an
   * applicant already knows their own application exists.
   */
  async permit(accountId: string, applicationId: string): Promise<{
    permitNumber: string; issuedDate: string; scope: string | null;
    conditions: readonly string[];
    release: { status: string; method: string | null; releasedAt: string | null } | null;
  } | null> {
    if (await this.byId(accountId, applicationId) === null) return null;

    const result = await this.db.query<{
      permit_number: string; issued_date: Date; scope: string | null; conditions: string[];
      release_status: string | null; release_method: string | null; released_at: Date | null;
    }>(
      `select g.permit_number, g.issued_date, g.scope, g.conditions,
              r.status as release_status, r.method as release_method, r.released_at
         from generated_permits g
         left join permit_releases r on r.application_id = g.application_id
        where g.application_id = $1`,
      [applicationId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      permitNumber: row.permit_number,
      issuedDate: row.issued_date.toISOString(),
      scope: row.scope,
      conditions: row.conditions,
      // Whether it can be collected yet, and how. Null before an officer has
      // set it: "not ready" is a fact the applicant should read rather than
      // infer from an absent field.
      release: row.release_status === null ? null : {
        status: row.release_status,
        method: row.release_method,
        releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
      },
    };
  }

  /** The application's own history, in the applicant's vocabulary. */
  async timeline(accountId: string, applicationId: string): Promise<ReadonlyArray<Record<string, unknown>> | null> {
    if (await this.byId(accountId, applicationId) === null) return null;

    const result = await this.db.query<{
      to_status: string; occurred_at: Date; remarks: string | null;
    }>(
      `select t.to_status, t.occurred_at, t.remarks
         from application_transitions t
        where t.application_id = $1
        order by t.occurred_at`,
      [applicationId],
    );

    // `from_status` and `office` are deliberately absent. An applicant does not
    // need to know which internal desk a file sat on, and the pair of statuses
    // reconstructs the officer's view of the pipeline.
    return result.rows.map((row) => ({
      status: row.to_status,
      occurredAt: new Date(row.occurred_at).toISOString(),
      remarks: row.remarks,
    }));
  }

  private toRecord(row: Record<string, unknown>, calendar: Awaited<ReturnType<CalendarRepository['load']>>): ApplicationRecord {
    const date = (value: unknown): Date | null =>
      value === null || value === undefined ? null : new Date(value as string);

    const submitted = date(row.submitted_at);
    const pledged = row.pledged_working_days;
    const suspendedFrom = date(row.suspended_from);

    const pledge = computePledge({
      classification: (row.classification as Classification | null) ?? null,
      pledgedWorkingDays: pledged === null || pledged === undefined ? null : Number(pledged),
      startedAt: submitted,
      now: this.clock(),
      calendar,
      suspensions: suspendedFrom === null ? [] : [{ from: suspendedFrom, to: date(row.suspended_to) }],
      completedAt: date(row.completed_at),
    });

    return {
      id: row.id as string,
      referenceNumber: row.reference_number as string,
      permitType: row.permit_type as string,
      // The name a citizen would recognise, beside the internal key.
      // Additive: `permitType` keeps its meaning, so no client breaks. It exists
      // because the admin portal was casting the key into its own published-name
      // union with `as`, holding a value that union does not contain.
      permitTypeName: publishedNameFor(row.permit_type as string),
      serviceDomain: row.service_domain as string,
      applicationAction: row.application_action as string,
      lifecycleStatus: row.lifecycle_status as ApplicationRecord['lifecycleStatus'],
      businessId: (row.business_id as string | null) ?? null,
      businessName: (row.business_name as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      classification: (row.classification as string | null) ?? null,
      pledgedWorkingDays: pledge?.pledgedWorkingDays ?? null,
      pledgeDueDate: pledge?.dueDate ?? null,
      pledgeApproximate: pledge?.approximate ?? false,
      pledgeSuspendedSince: date(row.pledge_suspended_since),
      dateSubmitted: submitted,
      updatedAt: date(row.updated_at) ?? new Date(0),
      openInstructionCount: Number(row.open_instruction_count ?? 0),
      form: (row.form as Record<string, unknown> | null) ?? {},
      paymentSubmittedAt: date(row.payment_submitted_at),
      paymentVerifiedAt: date(row.payment_verified_at),
      orderOfPayment: row.oop_number === null || row.oop_number === undefined ? null : {
        number: row.oop_number as string,
        assessedAt: date(row.oop_assessed_at) ?? new Date(0),
        dueDate: (row.oop_due_date as string | null) ?? null,
        feeScheduleVersion: row.oop_version as string,
        filingCentavos: Number(row.filing_centavos),
        processingCentavos: Number(row.processing_centavos),
        architecturalCentavos: Number(row.architectural_centavos),
        structuralCentavos: Number(row.structural_centavos),
        electricalCentavos: Number(row.electrical_centavos),
        othersCentavos: Number(row.others_centavos),
        totalCentavos: Number(row.total_centavos),
      },
      // Officer-scope. Carried on the record type so the view can be trusted to
      // drop them, and never read from the database at all — a field that is
      // never loaded cannot be leaked by a change to the view.
      officer: null,
      applicantName: '',
      evaluationStage: null,
    };
  }
}
