import { SqlClient } from '../../../persistence/sql-client';
import { CalendarRepository } from '../../compliance/application/calendar.repository';
import { Classification, computePledge } from '../../compliance/domain/pledge-clock';
import { ApplicationRecord, toApplicantView } from './applicant-view';

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
   * The documents on this application, and what the office said about each.
   *
   * C-2. Every one of these fields already existed -- migration 027 gave a
   * document its own verdict, a standard reason code, custom feedback written
   * for this applicant, and a supersession chain -- and no citizen-facing route
   * read any of it. The application detail mentions documents nowhere.
   *
   * Two consequences, both of which this closes. An applicant could not see
   * WHY a document was turned back, so the office's careful reason ("Illegible"
   * plus "page 3 of the lot plan is cut off") reached nobody and the applicant
   * made another trip to ask. And `id` was undiscoverable: `GET /documents/:id/
   * content` and the resubmit route both take a document id, and there was no
   * route that ever returned one -- so a citizen could not re-download a file
   * they had uploaded themselves.
   *
   * The reason is returned as BOTH its code and its label. The code is what a
   * client switches on and what the LGU counts; the label is what the office
   * wrote and what a citizen reads. Sending only the code would make every
   * client keep its own copy of the catalogue -- and that catalogue is editable
   * by the LGU, so those copies would drift.
   *
   * Null for an application that is not theirs. An application with no
   * documents returns an empty list, which is a different and true answer.
   */
  async documents(accountId: string, applicationId: string):
  Promise<ReadonlyArray<Record<string, unknown>> | null> {
    if (await this.byId(accountId, applicationId) === null) return null;

    const result = await this.db.query<{
      id: string; label: string; file_name: string; content_type: string;
      byte_size: string; sha256: string; uploaded_at: Date; expires_on: string | null;
      requirement_code: string | null;
      review_status: string | null; review_remark: string | null; reviewed_at: Date | null;
      reason_code: string | null; reason_label: string | null; reason_description: string | null;
      supersedes_document_id: string | null; superseded_by_document_id: string | null;
      scan_cleared: boolean; quarantined: boolean;
    }>(
      `select d.id, d.label, d.file_name, d.content_type, d.byte_size::text as byte_size,
              d.requirement_code,
              d.sha256, d.uploaded_at, to_char(d.expires_on, 'YYYY-MM-DD') as expires_on,
              d.review_status, d.review_remark, d.reviewed_at,
              r.code as reason_code, r.label as reason_label, r.description as reason_description,
              d.supersedes_document_id,
              (select s.id from documents s
                where s.supersedes_document_id = d.id and s.deleted_at is null)
                as superseded_by_document_id,
              d.scan_cleared,
              (d.status = 'Rejected' and not d.scan_cleared) as quarantined
         from documents d
         left join document_review_reasons r on r.code = d.review_reason_code
        where d.application_id = $1 and d.deleted_at is null
        order by d.uploaded_at, d.id`,
      [applicationId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      fileName: row.file_name,
      contentType: row.content_type,
      // Text, not a number: byte_size is a bigint, and JSON numbers lose
      // precision where bigint does not. Every other size on this surface is
      // carried the same way.
      byteSize: row.byte_size,
      sha256: row.sha256,
      uploadedAt: row.uploaded_at.toISOString(),
      expiresOn: row.expires_on,
      // Which checklist entry this answers (C-6). Null means NOT ATTRIBUTED --
      // nobody recorded which requirement it is for -- and never that it
      // answers none.
      requirementCode: row.requirement_code,
      // The officer's verdict. Null until anyone has looked -- which is a real
      // state and says "not yet reviewed", not "nothing wrong".
      reviewStatus: row.review_status,
      reviewedAt: row.reviewed_at === null ? null : row.reviewed_at.toISOString(),
      reviewReason: row.reason_code === null ? null : {
        code: row.reason_code,
        label: row.reason_label,
        description: row.reason_description,
      },
      reviewRemark: row.review_remark,
      // The resubmission chain, both ways. A replacement is a new row pointing
      // at what it replaces, so the old document keeps its rejection and its
      // reason -- an applicant can see what was wrong AND what they sent
      // instead, which is exactly the pair that makes a rejection actionable.
      supersedesDocumentId: row.supersedes_document_id,
      supersededByDocumentId: row.superseded_by_document_id,
      // The malware scan, which is a DIFFERENT axis from the officer's verdict
      // and is deliberately not folded into it: a quarantined file is not an
      // evaluation outcome, and an officer's rejection does not mean a virus.
      // Two plain booleans rather than a new vocabulary, because both clients
      // throw on an enum value they do not recognise.
      scanCleared: row.scan_cleared,
      quarantined: row.quarantined,
      // `reviewed_by` is deliberately absent. Naming the officer who turned a
      // document back is the officer-identity leak the applicant boundary
      // exists to prevent.
    }));
  }

  /**
   * The checklist this application was judged against, and what answers it.
   *
   * C-6, and the reason the column exists: a field nothing reads is not a
   * feature. Until now `document_requirements` said what a permit type asks for
   * and `documents` held what was sent, and nothing joined them -- so no
   * surface could say which required document was missing without matching on
   * the label, which is a guess.
   *
   * Read from `applications.required_documents`, the snapshot taken at filing,
   * NOT the live catalogue. The checklist changes and a filed application must
   * not: someone who submitted everything asked of them in March cannot become
   * non-compliant in April because the LGU added a document.
   *
   * ── Why `unattributedDocuments` is returned beside the list ─────────────
   *
   * A document uploaded before migration 035, or by a client that sends no
   * code, has a null `requirement_code`. It may well answer a requirement --
   * nobody recorded which. Counting requirements with no matching code and
   * calling them missing would report EVERY item missing on an application
   * whose documents all predate the column, which is worse than reporting
   * nothing at all.
   *
   * So the count travels with the list. A caller cannot render "3 missing"
   * without also having been handed "and 7 documents nobody attributed", which
   * is the difference between a measurement and an accusation.
   */
  async requirements(accountId: string, applicationId: string): Promise<{
    requirements: ReadonlyArray<Record<string, unknown>>;
    unattributedDocuments: number;
    attributionComplete: boolean;
  } | null> {
    if (await this.byId(accountId, applicationId) === null) return null;

    const snapshot = await this.db.query<{ required_documents: unknown }>(
      'select required_documents from applications where id = $1', [applicationId]);
    const row = snapshot.rows[0];
    if (row === undefined) return null;

    const checklist = (row.required_documents ?? []) as ReadonlyArray<{
      code: string; label: string; description: string; required: boolean;
    }>;

    const documents = await this.db.query<{
      id: string; requirement_code: string | null; review_status: string | null;
    }>(
      `select d.id, d.requirement_code, d.review_status
         from documents d
        where d.application_id = $1 and d.deleted_at is null
          and not exists (select 1 from documents r
                           where r.supersedes_document_id = d.id and r.deleted_at is null)
        order by d.uploaded_at`,
      [applicationId],
    );

    const byCode = new Map<string, { id: string; reviewStatus: string | null }[]>();
    let unattributed = 0;
    for (const document of documents.rows) {
      if (document.requirement_code === null) { unattributed += 1; continue; }
      const existing = byCode.get(document.requirement_code) ?? [];
      existing.push({ id: document.id, reviewStatus: document.review_status });
      byCode.set(document.requirement_code, existing);
    }

    return {
      requirements: checklist.map((entry) => {
        const answering = byCode.get(entry.code) ?? [];
        return {
          code: entry.code,
          label: entry.label,
          description: entry.description,
          required: entry.required,
          // Only the CURRENT document for a requirement: a superseded one is
          // excluded above, so a replaced-and-accepted requirement does not
          // still read as rejected because of the document it replaced.
          documentIds: answering.map((document) => document.id),
          // 'provided' means a document is attributed to it. It does NOT mean
          // an officer accepted that document -- that is `reviewStatus` on the
          // document itself, and conflating the two would tell an applicant
          // their rejected lot plan satisfies the requirement it failed.
          status: answering.length > 0 ? 'provided' : 'not-provided',
        };
      }),
      unattributedDocuments: unattributed,
      // The one field that says whether 'not-provided' can be trusted. False
      // means some documents carry no code, so a 'not-provided' entry may in
      // fact have been answered by one of them.
      attributionComplete: unattributed === 0,
    };
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
      // Kept, and now equal to `permitType`. Since migration 033 the stored key
      // IS the office's published name, so there is one vocabulary and nothing
      // to translate -- this field used to be the output of a lookup table that
      // the D-10 ruling abolished. Retained rather than removed because both
      // citizen clients and the admin portal read it today, and the ruling was
      // that the backend moves and the front ends do not. It is redundant, and
      // is the one thing here worth retiring once no client reads it.
      permitTypeName: row.permit_type as string,
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
