import { SqlClient } from '../../../persistence/sql-client';
import { exactInteger } from '../../../persistence/numeric-parsing';
import { EvaluationService } from './evaluation.service';
import { CalendarRepository } from '../../compliance/application/calendar.repository';
import { Classification, HolidayCalendar, Pledge, Suspension, computePledge } from '../../compliance/domain/pledge-clock';
import { LifecycleStatus } from '../domain/lifecycle';
import { Caller } from '../domain/application';
import { visibleStatusesFor } from '../domain/visibility';
import { FormFilter, formFilterFor, formFilterSql } from '../domain/form-access';

/**
 * What an officer sees, and what an officer is allowed to count.
 *
 * The web admin has until now held every application in the browser and
 * filtered the array to produce its queues and its dashboard numbers. That is
 * two defects wearing one coat. It does not scale -- forty records is fine and
 * forty thousand is not -- and, more seriously, it means every officer's
 * browser is sent every applicant's business name, address and permit history
 * regardless of what their role needs. Aggregation belongs in SQL because that
 * is where the row can be counted without being disclosed.
 *
 * So this service returns two shapes and never the whole table: a paginated
 * page of summaries for a queue, and scalar counts for a dashboard.
 */

export interface QueueFilters {
  readonly statuses?: readonly LifecycleStatus[];
  readonly permitType?: string;
  /** Matches reference number, business name, or applicant name. */
  readonly search?: string;
  readonly submittedFrom?: Date;
  readonly submittedTo?: Date;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface QueueRow {
  readonly id: string;
  readonly referenceNumber: string;
  readonly permitType: string;
  /**
   * The published name for `permitType` -- now always equal to it.
   *
   * There used to be two vocabularies: short internal keys here ('Fencing',
   * 'Civil/Structural') against the longer names the admin and public portals
   * published, bridged by a lookup table. D-10 ended that -- since migration
   * 033 the office's published name IS the key -- so there is nothing to
   * translate and no null, and the type is narrowed to `string`.
   *
   * Kept because the admin portal and both citizen clients read it today. See
   * the same field on ApplicationRecord in applicant-view.ts.
   */
  readonly permitTypeName: string;
  readonly applicationAction: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly classification: string | null;
  readonly businessName: string | null;
  readonly applicantName: string;
  readonly location: string | null;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
  readonly openInstructionCount: number;
  readonly assessedAmountCentavos: number | null;
  readonly paymentVerified: boolean;
  /**
   * The RA 11032 pledge, computed by the compliance module's clock — the same
   * one the compliance report uses. Null where the charter has no entry for
   * this permit type, which is shown as "awaiting classification" rather than
   * as a deadline nobody promised.
   */
  readonly pledge: Pledge | null;
}

export interface QueuePage {
  readonly rows: readonly QueueRow[];
  readonly nextCursor: string | null;
}

/**
 * The scalars a dashboard needs. Every one is a `count`, computed by the
 * database over the whole table, so a total always equals the sum of its
 * visible breakdown -- which a client-side count over a paginated list cannot
 * guarantee and will silently get wrong.
 */
/** Last thirty days against the thirty before. Raw counts, never a percentage. */
export interface TrendPair {
  readonly recent: number;
  readonly previous: number;
}

export interface QueueTrend {
  readonly total: TrendPair;
  readonly pendingUnderReview: TrendPair;
  readonly paymentsAwaitingVerification: TrendPair;
  readonly approved: TrendPair;
  readonly readyForRelease: TrendPair;
}

const ZERO: TrendPair = { recent: 0, previous: 0 };
const EMPTY_TREND: QueueTrend = {
  total: ZERO, pendingUnderReview: ZERO, paymentsAwaitingVerification: ZERO,
  approved: ZERO, readyForRelease: ZERO,
};

export interface QueueMetrics {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly awaitingAction: number;
  /**
   * Applications past their pledged working days, computed with the compliance
   * module's clock over the open set only.
   *
   * Only the open set, for two reasons. It is bounded, so the figure does not
   * require loading every application ever filed to produce one number. And it
   * is the only set where the answer is actionable — whether a permit released
   * last March met its pledge is a question for the compliance report, which
   * measures a period rather than a moment.
   */
  readonly overduePledge: number;
  /**
   * Applications whose pledged days have run out on the calendar as it stands,
   * but where a year the period spans has not been proclaimed in full — so a
   * holiday still to be declared could move the deadline.
   *
   * A separate number rather than a flag, because the pledge clock will not
   * call an application overdue on an approximate calendar (M-12), and rightly:
   * accusing an LGU of missing a statutory deadline on a date that could still
   * move is the one error this must not make. These are the ones an officer
   * should look at anyway.
   */
  readonly pledgeIndeterminate: number;
  /** Movement, for the dashboard's month-over-month cards. */
  readonly trend: QueueTrend;
}


const parseCount = exactInteger('count');
const parseCentavos = exactInteger('amount');

/**
 * A whole number out of a column, whichever adapter returned it.
 *
 * `pg` hands back NUMERIC and BIGINT as strings and INTEGER as a number, and
 * PGlite does not always agree. Coercing through `String()` blindly would turn
 * an unexpected object into "[object Object]" and then into a parse failure
 * three frames away from the cause, so the two shapes that can legitimately
 * arrive are named and anything else fails here, where the column is known.
 */
function wholeFrom(label: string, value: unknown, parse: (raw: string) => number): number {
  if (typeof value === 'number') return parse(String(value));
  if (typeof value === 'string') return parse(value);
  if (typeof value === 'bigint') return parse(value.toString());
  throw new Error(`${label} came back as ${typeof value}, which is not a number this can read`);
}

/**
 * One query per page, joining only what a queue row displays.
 *
 * The counts that gate a decision -- open instructions, whether payment is
 * verified -- are lateral subqueries rather than joins, because a join to a
 * one-to-many table multiplies the row and a reader has to notice the
 * `distinct` to know it was handled. A subquery cannot be got wrong that way.
 */
const QUEUE_SQL = `
  select
    a.id,
    a.reference_number,
    a.permit_type,
    a.application_action,
    a.lifecycle_status,
    a.classification,
    b.name as business_name,
    ap.first_name || ' ' || ap.last_name as applicant_name,
    a.location,
    a.submitted_at,
    a.updated_at,
    a.version,
    (select count(*) from instruction_items ii
       join letters_of_instruction l on l.id = ii.letter_id
      where l.application_id = a.id and ii.resolved_at is null) as open_instruction_count,
    (select o.total_centavos from orders_of_payment o
      where o.application_id = a.id and o.superseded_at is null
      order by o.assessed_at desc limit 1) as assessed_amount_centavos,
    exists (select 1 from payments p
             where p.application_id = a.id and p.verified_at is not null) as payment_verified,
    a.classification as charter_classification,
    a.form,
    a.form_validated_against,
    a.pledge_suspended_since,
    ce.pledged_working_days,
    (select min(t.occurred_at) from application_transitions t
      where t.application_id = a.id and t.to_status = 'Revision Required') as suspended_from,
    (select min(t.occurred_at) from application_transitions t
      where t.application_id = a.id and t.from_status = 'Revision Required'
        and t.to_status = 'Under Evaluation') as suspended_to,
    (select max(t.occurred_at) from application_transitions t
      where t.application_id = a.id
        and t.to_status in ('Released', 'Completed', 'Rejected')) as completed_at
  from applications a
  join applicants ap on ap.id = a.applicant_id
  left join businesses b on b.id = a.business_id
  left join charter_entries ce on ce.id = a.charter_entry_id
`;

export class StaffQueueService {
  constructor(
    private readonly db: SqlClient,
    private readonly calendars: CalendarRepository,
    private readonly evaluations: EvaluationService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Which permit types this caller's rows may be drawn from.
   *
   * Read per request rather than carried in the token, deliberately. Scopes
   * stay global and coarse — `account.ts` argues why — and an allow-list in the
   * token would have to be reissued whenever a super admin changed it, so an
   * officer's access would lag their assignment by up to the token lifetime.
   * One indexed read is the cost of the assignment taking effect immediately.
   *
   * An applicant is not governed by the list at all: they read their own
   * records through ownership.
   */
  private async formsFor(caller: Caller): Promise<ReturnType<typeof formFilterFor>> {
    if (caller.kind !== 'staff') return formFilterFor(caller, null);

    const { rows } = await this.db.query<{ permit_type: string }>(
      `select p.permit_type from staff_permit_access p
         join permit_types t on t.permit_type = p.permit_type and t.retired_at is null
        where p.account_id = $1`,
      [caller.accountId],
    );
    const level = await this.db.query<{ level: string }>(
      'select level from staff_access where account_id = $1', [caller.accountId]);

    // No assignment row means no access, never all access.
    if (level.rows.length === 0) return formFilterFor(caller, null);
    return formFilterFor(caller, {
      level: level.rows[0]!.level === 'view-edit' ? 'view-edit' : 'view',
      permitTypes: rows.map((row) => row.permit_type),
    });
  }


  async page(caller: Caller, filters: QueueFilters = {}): Promise<QueuePage> {
    const visible = visibleStatusesFor(caller);
    if (Array.isArray(visible) && visible.length === 0) return { rows: [], nextCursor: null };

    // Archived applications are out of the working queue by default -- that is
    // what archiving IS. Without this the act is cosmetic and an officer who
    // tidied their queue would watch it refill on the next refresh.
    const where: string[] = ["a.lifecycle_status <> 'Draft'", 'a.archived_at is null'];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (visible !== 'all') where.push(`a.lifecycle_status = any(${bind(visible)})`);

    // The forms allow-list, ANDed into the query rather than applied to the
    // rows afterwards. Filtering after the fact would still have COUNTED the
    // rows, and an officer who can see the queue holds 412 applications when 38
    // are theirs has learned the size of every other office's workload.
    const forms = formFilterSql(await this.formsFor(caller), 'a.permit_type', values.length + 1);
    if (forms.sql === 'false') return { rows: [], nextCursor: null };
    if (forms.sql !== 'true') {
      where.push(forms.sql);
      values.push(...forms.params);
    }

    // An explicit status filter narrows what the caller may see; it can never
    // widen it, because the visibility clause above is still ANDed in.
    if (filters.statuses !== undefined && filters.statuses.length > 0) {
      where.push(`a.lifecycle_status = any(${bind(filters.statuses)})`);
    }
    if (filters.permitType !== undefined) where.push(`a.permit_type = ${bind(filters.permitType)}`);
    if (filters.submittedFrom !== undefined) where.push(`a.submitted_at >= ${bind(filters.submittedFrom)}`);
    if (filters.submittedTo !== undefined) where.push(`a.submitted_at <= ${bind(filters.submittedTo)}`);
    if (filters.search !== undefined && filters.search.trim() !== '') {
      // Escaped, because an officer searching for a business called "100%
      // Fresh" must not silently match everything.
      const term = `%${filters.search.trim().replace(/([%_\\])/g, '\\$1')}%`;
      const t = bind(term);
      where.push(`(a.reference_number ilike ${t} or b.name ilike ${t}
                   or (ap.first_name || ' ' || ap.last_name) ilike ${t})`);
    }

    // Keyset, not offset. An officer working a queue is changing the very rows
    // that order it, so an OFFSET page silently skips or repeats records as
    // they move -- which in a permit queue means an application nobody opens.
    if (filters.cursor !== undefined) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded === null) return { rows: [], nextCursor: null };
      where.push(`(a.updated_at, a.id) < (${bind(decoded.updatedAt)}, ${bind(decoded.id)})`);
    }

    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const sql = `${QUEUE_SQL} where ${where.join(' and ')}
                 order by a.updated_at desc, a.id desc limit ${bind(limit + 1)}`;

    const result = await this.db.query<Record<string, never>>(sql, values);
    const raw = result.rows as unknown as ReadonlyArray<Record<string, unknown>>;
    const hasMore = raw.length > limit;
    const page = hasMore ? raw.slice(0, limit) : raw;
    const calendar = await this.calendars.load();
    const rows = page.map((row) => this.toQueueRow(row, calendar));
    const last = page[page.length - 1];

    return {
      rows,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor(new Date(last['updated_at'] as string), last['id'] as string)
        : null,
    };
  }

  /**
   * One application in full, or null.
   *
   * Null for "no such application" and for "not one you may read" alike. The
   * distinction is deliberately not exposed: telling a cashier that reference
   * BP-2026-000412 exists but is not theirs to open confirms a neighbour has
   * applied for a permit, which is precisely what the row filter is for.
   */
  async detail(caller: Caller, applicationId: string): Promise<StaffApplicationDetail | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(applicationId)) return null;
    const visible = visibleStatusesFor(caller);
    if (Array.isArray(visible) && visible.length === 0) return null;

    const values: unknown[] = [applicationId];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($2)';
    if (visible !== 'all') values.push(visible);

    // Deliberately NOT filtered by `archived_at`. Archiving takes an
    // application out of the working QUEUE; it does not take it away from an
    // officer who follows a link to it, and a record the LGU holds must stay
    // readable by the people accountable for it. The asymmetry is the point.
    const head = await this.db.query<Record<string, never>>(
      `${QUEUE_SQL} where a.id = $1 and a.lifecycle_status <> 'Draft'${clause}`,
      values,
    );
    const row = (head.rows as unknown as ReadonlyArray<Record<string, unknown>>)[0];
    if (row === undefined) return null;

    const calendar = await this.calendars.load();
    const [account, business, documents, evaluations, payments, oop, permit, release, instructions, timeline] =
      await Promise.all([
        this.db.query<{ email: string }>(
          `select acc.email from applications a
             join applicants ap on ap.id = a.applicant_id
             join accounts acc on acc.id = ap.account_id
            where a.id = $1`, [applicationId]),
        // Named columns, never `b.*`. A select-star sends whatever the next
        // migration adds -- owner ids, audit columns, a field added for an
        // unrelated feature -- to every officer's browser, and nobody reviews a
        // disclosure that happened by default.
        this.db.query(
          `select b.id, b.name, b.category, b.street, b.barangay, b.city, b.province,
                  b.registration_number, to_char(b.date_registered, 'YYYY-MM-DD') as date_registered,
                  b.status
             from applications a join businesses b on b.id = a.business_id where a.id = $1`,
          [applicationId]),
        this.db.query(
          `select id, label, file_name, content_type, byte_size, status, scan_cleared,
                  to_char(expires_on, 'YYYY-MM-DD') as expires_on, uploaded_at
             from documents where application_id = $1 and deleted_at is null
            order by uploaded_at`, [applicationId]),
        // Not a query of its own. Reading evaluations belongs to the
        // evaluations module, and this view asking the same question a second
        // way is how the two answers start disagreeing.
        this.evaluations.of(applicationId),
        this.db.query(
          `select id, reference_number, amount_centavos, method, status, submitted_at,
                  verified_at, official_receipt_number
             from payments where application_id = $1 order by submitted_at`, [applicationId]),
        this.db.query(
          `select id, number, total_centavos, filing_centavos, processing_centavos,
                  architectural_centavos, structural_centavos, electrical_centavos,
                  others_centavos, fee_schedule_version, assessed_at,
                  to_char(due_date, 'YYYY-MM-DD') as due_date
             from orders_of_payment
            where application_id = $1 and superseded_at is null
            order by assessed_at desc limit 1`, [applicationId]),
        this.db.query(
          `select permit_number, to_char(issued_date, 'YYYY-MM-DD') as issued_date, scope, conditions
             from generated_permits where application_id = $1`, [applicationId]),
        this.db.query(
          `select status, method, claimant_name, released_at, claim_location, office_hours, bring_with_you
             from permit_releases where application_id = $1`, [applicationId]),
        this.db.query(
          `select ii.id, ii.subject, ii.remark, l.issued_at
             from instruction_items ii
             join letters_of_instruction l on l.id = ii.letter_id
            where l.application_id = $1 and ii.resolved_at is null
            order by l.issued_at`, [applicationId]),
        // The timeline the database trigger writes on every committed
        // transition. Read from there rather than from the audit chain because
        // this is the record's own history, not the security log -- which also
        // records refused attempts, a different question and in some hands a
        // disclosure.
        this.db.query(
          `select t.from_status, t.to_status, t.occurred_at, t.office, t.remarks
             from application_transitions t
            where t.application_id = $1 order by t.occurred_at`, [applicationId]),
      ]);

    const one = (r: { rows: unknown[] }): Readonly<Record<string, unknown>> | null => {
      const first = r.rows[0] as Record<string, unknown> | undefined;
      return first === undefined ? null : camelKeys(first);
    };
    const many = (r: { rows: unknown[] }): ReadonlyArray<Record<string, unknown>> =>
      (r.rows as Record<string, unknown>[]).map(camelKeys);

    return {
      summary: this.toQueueRow(row, calendar),
      applicantEmail: account.rows[0]?.email ?? '',
      form: (row['form'] as Record<string, unknown> | null) ?? {},
      formValidatedAgainst: (row['form_validated_against'] as string | null) ?? null,
      business: one(business),
      documents: many(documents),
      // Already shaped by the reader; `many` exists to camel-case raw rows.
      evaluations,
      payments: many(payments),
      orderOfPayment: one(oop),
      permit: one(permit),
      release: one(release),
      openInstructions: many(instructions),
      timeline: many(timeline),
    };
  }

  /**
   * Counts, computed by the database over every row the caller may see.
   *
   * Never derived from `page()`: a dashboard built from the first page of a
   * queue reports the size of that page and calls it the size of the backlog.
   */
  async metrics(caller: Caller): Promise<QueueMetrics> {
    const visible = visibleStatusesFor(caller);
    const forms = await this.formsFor(caller);
    // Every figure below is computed over the caller's VISIBLE SET, not over
    // the table. A dashboard that counts work an officer cannot open is worse
    // than one that shows nothing: it reports a backlog they are not permitted
    // to reduce, and the number moves when another office's queue does.
    const empty: QueueMetrics = {
      total: 0, byStatus: {}, awaitingAction: 0, overduePledge: 0, pledgeIndeterminate: 0,
      trend: EMPTY_TREND,
    };
    if (Array.isArray(visible) && visible.length === 0) return empty;
    if (formFilterSql(forms, 'a.permit_type', 1).sql === 'false') return empty;

    const values: unknown[] = [];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($1)';
    if (visible !== 'all') values.push(visible);
    const formsHere = formFilterSql(forms, 'a.permit_type', values.length + 1);
    const formsClause = formsHere.sql === 'true' ? '' : ` and ${formsHere.sql}`;
    values.push(...formsHere.params);

    const result = await this.db.query<{ lifecycle_status: string; n: string }>(
      `select a.lifecycle_status, count(*) as n
         from applications a
        where a.lifecycle_status <> 'Draft' and a.archived_at is null${clause}${formsClause}
        group by a.lifecycle_status`,
      values,
    );

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      const n = parseCount(row.n);
      byStatus[row.lifecycle_status] = n;
      total += n;
    }

    // "Awaiting action" is the officer's backlog: filed, not yet resolved, and
    // not waiting on the applicant. Revision Required is deliberately excluded
    // -- the ball is with the applicant, and counting it as officer backlog
    // makes an LGU look slower than it is and hides the queue that is real.
    const WAITING_ON_STAFF = [
      'Submitted', 'Received', 'Document Verification', 'Under Evaluation',
      'Assessed', 'Payment Submitted', 'Payment Under Verification',
      'Payment Verified', 'For Approval', 'Approved', 'Permit Generated',
      'Ready for Release',
    ];
    const awaitingAction = WAITING_ON_STAFF.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);

    const { overdue, indeterminate } = await this.overdue(visible, forms);
    const trend = await this.trend(visible, forms);

    return { total, byStatus, awaitingAction, overduePledge: overdue, pledgeIndeterminate: indeterminate, trend };
  }

  /**
   * The statutory figure, over the open set only.
   *
   * Computed row by row with the compliance module's clock rather than in SQL.
   * A `submitted_at + n days` comparison is a second, wrong implementation of
   * RA 11032: it counts weekends and proclaimed holidays as working days and
   * ignores the applicant's own suspension, so it reports breaches that did not
   * happen. Bounded to the open set, this is tens or hundreds of rows, not the
   * whole table.
   */
  /**
   * The last thirty days against the thirty before, per headline figure.
   *
   * RAW COUNTS, never a percentage. The portal's own store is explicit about
   * why: a card needs to tell "no change" from "no baseline to compare
   * against", and one number cannot say both. A server that helpfully computed
   * +0% would erase the difference between a quiet month and a first month.
   *
   * Counted on `submitted_at`, which is when the LGU received the application —
   * the same date the portal's store measures from. Counting on `updated_at`
   * would make a figure move because someone opened a record.
   *
   * The status predicates are the portal's, verbatim, because they are the
   * definitions its cards already carry. `paymentsAwaitingVerification` is the
   * single status 'Payment Under Verification', not the pair that sounds like
   * it: a payment merely submitted is waiting on nobody at the LGU yet.
   */
  private async trend(
    visible: readonly LifecycleStatus[] | 'all', forms: FormFilter,
  ): Promise<QueueTrend> {
    const now = this.clock();
    const day = 24 * 60 * 60 * 1000;
    const values: unknown[] = [new Date(now.getTime() - 60 * day), new Date(now.getTime() - 30 * day), now];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($4)';
    if (visible !== 'all') values.push(visible);
    const formsHere = formFilterSql(forms, 'a.permit_type', values.length + 1);
    const formsClause = formsHere.sql === 'true' ? '' : ` and ${formsHere.sql}`;
    values.push(...formsHere.params);

    const rows = await this.db.query<{ lifecycle_status: string; bucket: string; n: string }>(
      `select a.lifecycle_status,
              -- Named bucket, not window: WINDOW is a reserved word in SQL,
              -- and the parse error names the token rather than the column.
              case when a.submitted_at >= $2 then 'recent' else 'previous' end as bucket,
              count(*) as n
         from applications a
        where a.lifecycle_status <> 'Draft' and a.archived_at is null
          and a.submitted_at >= $1 and a.submitted_at < $3${clause}${formsClause}
        group by a.lifecycle_status, bucket`,
      values,
    );

    const count = (statuses: readonly string[], window: string): number => rows.rows
      .filter((row) => row.bucket === window && statuses.includes(row.lifecycle_status))
      .reduce((sum, row) => sum + parseCount(row.n), 0);
    const all = rows.rows.map((row) => row.lifecycle_status);
    const pair = (statuses: readonly string[]): { recent: number; previous: number } => ({
      recent: count(statuses, 'recent'),
      previous: count(statuses, 'previous'),
    });

    return {
      total: { recent: count(all, 'recent'), previous: count(all, 'previous') },
      pendingUnderReview: pair(['Submitted', 'Received', 'Document Verification', 'Under Evaluation']),
      paymentsAwaitingVerification: pair(['Payment Under Verification']),
      approved: pair(['Approved', 'Permit Generated', 'Ready for Release', 'Released', 'Completed']),
      readyForRelease: pair(['Ready for Release']),
    };
  }

  private async overdue(
    visible: readonly LifecycleStatus[] | 'all',
    forms: FormFilter,
  ): Promise<{ overdue: number; indeterminate: number }> {
    const values: unknown[] = [];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($1)';
    if (visible !== 'all') values.push(visible);
    // The statutory figure must be over the caller's own forms too: an officer
    // told they have 14 overdue applications, 11 of which belong to another
    // office, cannot act on the number and cannot correct it.
    const formsHere = formFilterSql(forms, 'a.permit_type', values.length + 1);
    const formsClause = formsHere.sql === 'true' ? '' : ` and ${formsHere.sql}`;
    values.push(...formsHere.params);

    const result = await this.db.query<Record<string, never>>(
      `select a.id, a.classification as charter_classification, a.submitted_at,
              ce.pledged_working_days,
              (select min(t.occurred_at) from application_transitions t
                where t.application_id = a.id and t.to_status = 'Revision Required') as suspended_from,
              (select min(t.occurred_at) from application_transitions t
                where t.application_id = a.id and t.from_status = 'Revision Required'
                  and t.to_status = 'Under Evaluation') as suspended_to
         from applications a
         left join charter_entries ce on ce.id = a.charter_entry_id
        where a.lifecycle_status not in
              ('Draft', 'Released', 'Completed', 'Rejected', 'Cancelled', 'Expired')${clause}${formsClause}`,
      values,
    );

    const calendar = await this.calendars.load();
    const now = this.clock();
    let overdue = 0;
    let indeterminate = 0;

    for (const row of result.rows as unknown as ReadonlyArray<Record<string, unknown>>) {
      const pledge = pledgeOf({ ...row, completed_at: null }, calendar, now);
      if (pledge === null) continue;
      if (pledge.overdue) overdue += 1;
      else if (pledge.approximate && pledge.workingDaysRemaining < 0) indeterminate += 1;
    }

    return { overdue, indeterminate };
  }

  private toQueueRow(row: Record<string, unknown>, calendar: HolidayCalendar): QueueRow {
    const submitted = row['submitted_at'];
    const amount = row['assessed_amount_centavos'];

    return {
      id: row['id'] as string,
      referenceNumber: row['reference_number'] as string,
      permitType: row['permit_type'] as string,
      // Kept, and now equal to `permitType`. Since migration 033 the stored key
      // IS the office's published name, so there is one vocabulary and nothing
      // to translate -- this field used to be the output of a lookup table that
      // the D-10 ruling abolished. Retained rather than removed because both
      // citizen clients and the admin portal read it today, and the ruling was
      // that the backend moves and the front ends do not. It is redundant, and
      // is the one thing here worth retiring once no client reads it.
      permitTypeName: row['permit_type'] as string,
      applicationAction: row['application_action'] as string,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      classification: (row['classification'] as string | null) ?? null,
      businessName: (row['business_name'] as string | null) ?? null,
      applicantName: row['applicant_name'] as string,
      location: (row['location'] as string | null) ?? null,
      submittedAt: submitted === null || submitted === undefined ? null : new Date(submitted as string).toISOString(),
      updatedAt: new Date(row['updated_at'] as string).toISOString(),
      version: wholeFrom('version', row['version'], parseCount),
      openInstructionCount: wholeFrom('open instruction count', row['open_instruction_count'], parseCount),
      assessedAmountCentavos: amount === null || amount === undefined
        ? null
        : wholeFrom('assessed amount', amount, parseCentavos),
      paymentVerified: row['payment_verified'] === true,
      pledge: pledgeOf(row, calendar, this.clock()),
    };
  }

}

/**
 * Database column names as the rest of this API spells them.
 *
 * Postgres answers in snake_case and every other response here is camelCase.
 * Letting the raw rows through made the officer's detail view the one endpoint
 * a client had to spell differently -- and the admin's mapper had already grown
 * `row['uploaded_at'] ?? row['uploadedAt']` hedges, written by someone who could
 * not tell which they would get. Converting here means there is one answer.
 */
function camelKeys(row: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    converted[key.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase())] = value;
  }
  return converted;
}

/**
 * One row's pledge, from the facts the query already carried.
 *
 * Shared by the page and the overdue count so both answer the same question
 * the same way. The suspension span is the applicant's own time under RA
 * 11032 -- from the move into Revision Required to the resubmission -- and
 * omitting it makes an LGU look like it breached a deadline it in fact met.
 */
function pledgeOf(row: Record<string, unknown>, calendar: HolidayCalendar, now: Date): Pledge | null {
  const suspendedFrom = row['suspended_from'];
  const suspensions: Suspension[] =
    suspendedFrom === null || suspendedFrom === undefined
      ? []
      : [{
          from: new Date(suspendedFrom as string),
          to: row['suspended_to'] === null || row['suspended_to'] === undefined
            ? null
            : new Date(row['suspended_to'] as string),
        }];

  const pledged = row['pledged_working_days'];
  const submitted = row['submitted_at'];
  const completed = row['completed_at'];

  return computePledge({
    classification: (row['charter_classification'] as Classification | null) ?? null,
    pledgedWorkingDays: pledged === null || pledged === undefined ? null : Number(pledged),
    startedAt: submitted === null || submitted === undefined ? null : new Date(submitted as string),
    now,
    calendar,
    suspensions,
    completedAt: completed === null || completed === undefined ? null : new Date(completed as string),
  });
}

/**
 * Opaque only in the sense that a client has no business parsing it. It is not
 * signed, because it carries no authority: the visibility clause is applied
 * again on every request, so a forged cursor can only reposition a caller
 * inside rows they were already entitled to read.
 */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (at === undefined || id === undefined) return null;
    const updatedAt = new Date(at);
    if (Number.isNaN(updatedAt.getTime())) return null;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/**
 * Everything an officer opens on one application.
 *
 * Assembled server-side and returned whole. The alternative — the client
 * fetching seven collections and stitching them — is what the in-memory admin
 * did with seven signals, and it produces a screen where the documents belong
 * to the application and the payment does not, because one request failed and
 * nothing noticed.
 */
export interface StaffApplicationDetail {
  readonly summary: QueueRow;
  readonly applicantEmail: string;
  /**
   * The applicant's own answers, and what checked them.
   *
   * An officer evaluating an application needs this more than anyone. Storing
   * it and not showing it here would leave the evaluation exactly where it was
   * when the form was being discarded — a permit type, a location and a stack
   * of documents.
   *
   * `formValidatedAgainst` is null wherever no schema existed when the
   * application was filed, which is currently all of them. An officer reading
   * an unusual answer should know whether anything checked it.
   */
  readonly form: Readonly<Record<string, unknown>>;
  readonly formValidatedAgainst: string | null;
  readonly business: Readonly<Record<string, unknown>> | null;
  readonly documents: ReadonlyArray<Record<string, unknown>>;
  readonly evaluations: ReadonlyArray<Record<string, unknown>>;
  readonly payments: ReadonlyArray<Record<string, unknown>>;
  readonly orderOfPayment: Readonly<Record<string, unknown>> | null;
  readonly permit: Readonly<Record<string, unknown>> | null;
  readonly release: Readonly<Record<string, unknown>> | null;
  readonly openInstructions: ReadonlyArray<Record<string, unknown>>;
  readonly timeline: ReadonlyArray<Record<string, unknown>>;
}

// Re-exported where it used to live. The rule moved to the domain (see
// `domain/visibility.ts`); callers that reached for it here are not wrong about
// wanting it, and a move is not a reason to break them.
export { visibleStatusesFor };
