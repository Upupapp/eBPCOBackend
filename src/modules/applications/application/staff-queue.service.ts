import { SqlClient } from '../../../persistence/sql-client';
import { exactInteger } from '../../../persistence/numeric-parsing';
import { CalendarRepository } from '../../compliance/application/calendar.repository';
import { Classification, HolidayCalendar, Pledge, Suspension, computePledge } from '../../compliance/domain/pledge-clock';
import { LifecycleStatus } from '../domain/lifecycle';
import { Caller } from '../domain/application';

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
}

/**
 * Least privilege, expressed as a row filter rather than a UI decision.
 *
 * A cashier has no reason to read an application that has not reached
 * assessment, and a releasing officer has no reason to read one that has not
 * been approved. Hiding those rows in the client would still send them; this
 * refuses to select them. Roles that legitimately see the whole pipeline --
 * records, building official, administrator -- are listed explicitly, so
 * granting that breadth to a new role is a visible change here rather than an
 * accident of an omitted case.
 */
const SCOPE_VISIBILITY: ReadonlyArray<{ scope: string; statuses: readonly LifecycleStatus[] | 'all' }> = [
  { scope: 'staff:administer', statuses: 'all' },
  { scope: 'applications:write', statuses: 'all' },
  { scope: 'staff:approve', statuses: 'all' },
  { scope: 'staff:evaluate', statuses: ['Submitted', 'Received', 'Document Verification', 'Under Evaluation', 'Revision Required'] },
  { scope: 'staff:assess', statuses: ['Under Evaluation', 'Assessed'] },
  { scope: 'staff:verify-payment', statuses: ['Assessed', 'Payment Submitted', 'Payment Under Verification', 'Payment Verified'] },
  { scope: 'staff:release', statuses: ['Approved', 'Permit Generated', 'Ready for Release', 'Released', 'Completed'] },
];

/**
 * Which statuses this caller may see at all. Empty means none -- and an empty
 * result is the correct answer for a staff account holding no read-bearing
 * scope, rather than an error, because a role can legitimately exist that only
 * administers accounts.
 */
export function visibleStatusesFor(caller: Caller): readonly LifecycleStatus[] | 'all' {
  if (caller.kind !== 'staff') return [];
  const held = new Set(caller.scopes);
  const matched = SCOPE_VISIBILITY.filter((rule) => held.has(rule.scope));
  if (matched.some((rule) => rule.statuses === 'all')) return 'all';
  const union = new Set<LifecycleStatus>();
  for (const rule of matched) {
    if (rule.statuses !== 'all') rule.statuses.forEach((s) => union.add(s));
  }
  return [...union];
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
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async page(caller: Caller, filters: QueueFilters = {}): Promise<QueuePage> {
    const visible = visibleStatusesFor(caller);
    if (Array.isArray(visible) && visible.length === 0) return { rows: [], nextCursor: null };

    const where: string[] = ["a.lifecycle_status <> 'Draft'"];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (visible !== 'all') where.push(`a.lifecycle_status = any(${bind(visible)})`);

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
        this.db.query(
          `select b.* from applications a join businesses b on b.id = a.business_id where a.id = $1`,
          [applicationId]),
        this.db.query(
          `select id, label, file_name, content_type, byte_size, status, scan_cleared,
                  expires_on, uploaded_at
             from documents where application_id = $1 and deleted_at is null
            order by uploaded_at`, [applicationId]),
        this.db.query(
          `select id, stage, result, remarks, evaluated_at from evaluations
            where application_id = $1 order by evaluated_at`, [applicationId]),
        this.db.query(
          `select id, reference_number, amount_centavos, method, status, submitted_at,
                  verified_at, official_receipt_number
             from payments where application_id = $1 order by submitted_at`, [applicationId]),
        this.db.query(
          `select * from orders_of_payment
            where application_id = $1 and superseded_at is null
            order by assessed_at desc limit 1`, [applicationId]),
        this.db.query(`select * from generated_permits where application_id = $1`, [applicationId]),
        this.db.query(`select * from permit_releases where application_id = $1`, [applicationId]),
        this.db.query(
          `select ii.id, ii.subject, ii.remark, l.issued_at
             from instruction_items ii
             join letters_of_instruction l on l.id = ii.letter_id
            where l.application_id = $1 and ii.resolved_at is null
            order by l.issued_at`, [applicationId]),
        // The timeline the database trigger writes on every committed
        // transition. Read from there rather than from the audit chain because
        // this is the record's own history, not the security log.
        this.db.query(
          `select t.from_status, t.to_status, t.occurred_at, t.office, t.remarks
             from application_transitions t
            where t.application_id = $1 order by t.occurred_at`, [applicationId]),
      ]);

    const one = (r: { rows: unknown[] }): Record<string, unknown> | null =>
      (r.rows[0] as Record<string, unknown> | undefined) ?? null;

    return {
      summary: this.toQueueRow(row, calendar),
      applicantEmail: account.rows[0]?.email ?? '',
      business: one(business),
      documents: documents.rows,
      evaluations: evaluations.rows,
      payments: payments.rows,
      orderOfPayment: one(oop),
      permit: one(permit),
      release: one(release),
      openInstructions: instructions.rows,
      timeline: timeline.rows,
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
    if (Array.isArray(visible) && visible.length === 0) {
      return { total: 0, byStatus: {}, awaitingAction: 0, overduePledge: 0, pledgeIndeterminate: 0 };
    }

    const values: unknown[] = [];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($1)';
    if (visible !== 'all') values.push(visible);

    const result = await this.db.query<{ lifecycle_status: string; n: string }>(
      `select a.lifecycle_status, count(*) as n
         from applications a
        where a.lifecycle_status <> 'Draft'${clause}
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

    const { overdue, indeterminate } = await this.overdue(visible);

    return { total, byStatus, awaitingAction, overduePledge: overdue, pledgeIndeterminate: indeterminate };
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
  private async overdue(
    visible: readonly LifecycleStatus[] | 'all',
  ): Promise<{ overdue: number; indeterminate: number }> {
    const values: unknown[] = [];
    const clause = visible === 'all' ? '' : ' and a.lifecycle_status = any($1)';
    if (visible !== 'all') values.push(visible);

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
              ('Draft', 'Released', 'Completed', 'Rejected', 'Cancelled', 'Expired')${clause}`,
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
