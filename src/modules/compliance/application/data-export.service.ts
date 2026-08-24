import { createHash } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { ObjectStore, newObjectKey } from '../../documents/domain/object-store';
import { AuditService } from './audit.service';
import { REGISTER } from '../domain/personal-data';

/**
 * A portable copy of one person's data, under RA 10173 §18.
 *
 * Two rules shape the whole of this, and both are about what is NOT in the
 * file.
 *
 * **No secrets.** The password verifier, the TOTP secret and the push-token
 * digests are all classified `secret` in the register, and every one of them is
 * *about* the subject. Handing them back is not access — it is handing over the
 * means to impersonate them, to whoever ends up with the file. The register is
 * what makes that a check rather than a memory: `assertNoSecrets` fails the
 * export if a secret-class column name appears anywhere in it.
 *
 * **No third parties.** The audit trail records officer actions on this
 * applicant's record, and its `before_state`/`after_state` blobs "may contain
 * any personal data from the row it describes" — which can include an officer's
 * account id, and in a superseded Order of Payment another person's details.
 * So the trail is exported as *what happened and when*, never as the raw state.
 * A portability right is a right to your own data, not to a window on everyone
 * who touched it.
 *
 * What IS in it is everything the register classifies as this person's: the
 * account, the applicant profile, businesses, applications with their
 * documents, evaluations, payments, orders of payment, permits and releases,
 * notifications, preferences and devices.
 */

export type ProduceResult =
  | { readonly ok: true; readonly requestId: string; readonly byteSize: number }
  | { readonly ok: false; readonly requestId: string; readonly detail: string };

/** How long a produced file stays downloadable. Short: it is the subject's whole record. */
export const EXPORT_TTL_HOURS = 48;

export class DataExportService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly store: ObjectStore,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  /**
   * Queues a request, or returns the one already outstanding.
   *
   * Returning the existing request rather than refusing: a person pressing the
   * button twice is not making a second request, and an error would read as the
   * LGU declining to answer a statutory right.
   */
  async request(accountId: string): Promise<{ requestId: string; requestedAt: string }> {
    const existing = await this.db.query<{ id: string; requested_at: Date }>(
      `select id, requested_at from data_export_requests
        where account_id = $1 and status = 'queued'`,
      [accountId],
    );
    const outstanding = existing.rows[0];
    if (outstanding !== undefined) {
      return {
        requestId: outstanding.id,
        requestedAt: new Date(outstanding.requested_at).toISOString(),
      };
    }

    const now = this.clock();
    const inserted = await this.db.query<{ id: string }>(
      `insert into data_export_requests (account_id, requested_at) values ($1,$2) returning id`,
      [accountId, now],
    );
    return { requestId: inserted.rows[0]?.id ?? '', requestedAt: now.toISOString() };
  }

  async statusOf(accountId: string, requestId: string): Promise<{
    requestId: string; status: string; requestedAt: string;
    completedAt: string | null; expiresAt: string | null;
    byteSize: number | null; sha256: string | null; failureDetail: string | null;
  } | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(requestId)) return null;
    // Scoped by account in the WHERE clause. Someone else's export request is
    // not theirs to look at, and 404 answers that the same as not-there.
    const result = await this.db.query<{
      id: string; status: string; requested_at: Date; completed_at: Date | null;
      expires_at: Date | null; byte_size: string | null; sha256: string | null;
      failure_detail: string | null;
    }>(
      `select id, status, requested_at, completed_at, expires_at, byte_size, sha256, failure_detail
         from data_export_requests where id = $1 and account_id = $2`,
      [requestId, accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      requestId: row.id,
      status: row.status,
      requestedAt: new Date(row.requested_at).toISOString(),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      sha256: row.sha256,
      failureDetail: row.failure_detail,
    };
  }

  /** A short-lived link, or null if there is nothing downloadable. */
  async downloadUrl(accountId: string, requestId: string): Promise<string | null> {
    const result = await this.db.query<{ storage_key: string; expires_at: Date }>(
      `select storage_key, expires_at from data_export_requests
        where id = $1 and account_id = $2 and status = 'ready' and storage_key is not null`,
      [requestId, accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    // Expiry is enforced here as well as by the sweeper. The sweeper runs
    // daily; a link must stop working the moment it is due to, not the next
    // time a job happens to run.
    if (new Date(row.expires_at) <= this.clock()) return null;

    const remainingSeconds = Math.max(
      60,
      Math.floor((new Date(row.expires_at).getTime() - this.clock().getTime()) / 1000),
    );
    return this.store.signedUrl(row.storage_key, Math.min(remainingSeconds, 900));
  }

  /** Produces the file for one queued request. Called by the scheduled job. */
  async produce(requestId: string): Promise<ProduceResult> {
    const request = await this.db.query<{ account_id: string }>(
      `select account_id from data_export_requests where id = $1 and status = 'queued'`,
      [requestId],
    );
    const accountId = request.rows[0]?.account_id;
    if (accountId === undefined) {
      return { ok: false, requestId, detail: 'no queued request with that id' };
    }

    try {
      const document = await this.assemble(accountId);
      assertNoSecrets(document);

      const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      const key = newObjectKey();
      await this.store.put(key, bytes, 'application/json');

      const now = this.clock();
      const expiresAt = new Date(now.getTime() + EXPORT_TTL_HOURS * 3_600_000);

      await this.db.transaction(async (tx) => {
        await tx.query(
          `update data_export_requests
              set status = 'ready', storage_key = $2, byte_size = $3, sha256 = $4,
                  completed_at = $5, expires_at = $6
            where id = $1`,
          [requestId, key, bytes.length, createHash('sha256').update(bytes).digest('hex'), now, expiresAt],
        );
        // The LGU has to be able to evidence that it answered. The entry carries
        // no personal data beyond the account the request belongs to.
        await this.audit.append({
          action: 'account.data-exported',
          subjectType: 'export',
          subjectId: requestId,
          outcome: 'allowed',
          actorAccountId: accountId,
          afterState: { byteSize: bytes.length, expiresAt: expiresAt.toISOString() },
        }, tx);
      });

      return { ok: true, requestId, byteSize: bytes.length };
    } catch (error) {
      const detail = summarise(error);
      await this.db.query(
        `update data_export_requests set status = 'failed', failure_detail = $2, completed_at = $3
          where id = $1`,
        [requestId, detail, this.clock()],
      );
      return { ok: false, requestId, detail };
    }
  }

  /** Deletes files whose window has closed, and marks the rows. */
  async sweepExpired(): Promise<{ expired: number }> {
    const due = await this.db.query<{ id: string; storage_key: string }>(
      `select id, storage_key from data_export_requests
        where status = 'ready' and expires_at <= $1 and storage_key is not null`,
      [this.clock()],
    );

    for (const row of due.rows) {
      await this.store.delete(row.storage_key);
      // The key is cleared as well as the status. A row that still names an
      // object which no longer exists invites a later reader to try to fetch it.
      await this.db.query(
        `update data_export_requests set status = 'expired', storage_key = null where id = $1`,
        [row.id],
      );
    }

    return { expired: due.rows.length };
  }

  /** Everything the register says is this person's, and nothing else's. */
  private async assemble(accountId: string): Promise<Record<string, unknown>> {
    const one = async <T>(sql: string, values: unknown[]): Promise<T[]> =>
      (await this.db.query<T>(sql, values)).rows;

    const account = await one<Record<string, unknown>>(
      `select id, kind, email, email_verified_at, mobile_number, mobile_verified_at,
              created_at, erased_at
         from accounts where id = $1`,
      [accountId],
    );

    const applicant = await one<Record<string, unknown>>(
      `select id, first_name, last_name, created_at from applicants where account_id = $1`,
      [accountId],
    );

    const businesses = await one<Record<string, unknown>>(
      `select b.id, b.name, b.category, b.street, b.barangay, b.city, b.province,
              b.registration_number, to_char(b.date_registered, 'YYYY-MM-DD') as date_registered,
              b.status, b.created_at
         from businesses b join applicants ap on ap.id = b.owner_applicant_id
        where ap.account_id = $1 order by b.name`,
      [accountId],
    );

    const applications = await one<Record<string, unknown>>(
      `select a.id, a.reference_number, a.permit_type, a.application_action, a.location,
              a.lifecycle_status, a.classification, a.submitted_at, a.created_at, a.updated_at
         from applications a join applicants ap on ap.id = a.applicant_id
        where ap.account_id = $1 order by a.submitted_at`,
      [accountId],
    );
    const applicationIds = applications.map((row) => row.id as string);

    const forApplications = async <T>(sql: string): Promise<T[]> =>
      applicationIds.length === 0 ? [] : one<T>(sql, [applicationIds]);

    return {
      _about: {
        subject: 'A copy of the personal data the LGU holds about you, under RA 10173 §18.',
        producedAt: this.clock().toISOString(),
        format: 'JSON. Amounts are in centavos; timestamps are RFC 3339 in UTC.',
        notIncluded: [
          'Your password, one-time-passcode secret and push-notification tokens. These are '
          + 'credentials rather than records: releasing them would let whoever holds this file '
          + 'act as you.',
          'The internal detail of officers’ actions on your applications. The history below says '
          + 'what happened and when; the underlying records can name other people, and a right to '
          + 'your own data is not a window on everyone who touched it.',
        ],
      },
      account: account[0] ?? null,
      applicantProfile: applicant[0] ?? null,
      businesses,
      applications,
      documents: await forApplications(
        `select id, application_id, label, file_name, content_type, byte_size, status,
                to_char(expires_on, 'YYYY-MM-DD') as expires_on, uploaded_at, deleted_at
           from documents where application_id = any($1) order by uploaded_at`,
      ),
      evaluations: await forApplications(
        `select id, application_id, stage, result, remarks, evaluated_at
           from evaluations where application_id = any($1) order by evaluated_at`,
      ),
      ordersOfPayment: await forApplications(
        `select id, application_id, number, filing_centavos, processing_centavos,
                architectural_centavos, structural_centavos, electrical_centavos,
                others_centavos, total_centavos, fee_schedule_version, assessed_at,
                to_char(due_date, 'YYYY-MM-DD') as due_date, superseded_at, superseded_reason
           from orders_of_payment where application_id = any($1) order by assessed_at`,
      ),
      payments: await forApplications(
        `select id, application_id, reference_number, amount_centavos, method, status,
                submitted_at, verified_at, official_receipt_number
           from payments where application_id = any($1) order by submitted_at`,
      ),
      lettersOfInstruction: await forApplications(
        `select l.id, l.application_id, l.issued_at, l.closed_at,
                ii.subject, ii.remark, ii.response, ii.resolved_at
           from letters_of_instruction l
           join instruction_items ii on ii.letter_id = l.id
          where l.application_id = any($1) order by l.issued_at`,
      ),
      permits: await forApplications(
        `select application_id, permit_number, to_char(issued_date, 'YYYY-MM-DD') as issued_date,
                scope, conditions
           from generated_permits where application_id = any($1)`,
      ),
      permitReleases: await forApplications(
        `select application_id, status, method, claimant_name, released_at,
                claim_location, office_hours, bring_with_you
           from permit_releases where application_id = any($1)`,
      ),
      // What happened, and when. Never the raw before/after state — see the
      // class comment.
      history: await forApplications(
        `select application_id, from_status, to_status, occurred_at, remarks
           from application_transitions where application_id = any($1) order by occurred_at`,
      ),
      notifications: await one<Record<string, unknown>>(
        `select id, type, application_id, title, body, created_at, read_at, resolved_at
           from notifications where account_id = $1 order by created_at`,
        [accountId],
      ),
      notificationPreferences: (await one<Record<string, unknown>>(
        `select muted_categories, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, updated_at
           from notification_preferences where account_id = $1`,
        [accountId],
      ))[0] ?? null,
      // Metadata only. The token itself is the credential for pushing to that
      // handset and is excluded with the other secrets.
      devices: await one<Record<string, unknown>>(
        `select id, platform, app_version, locale, registered_at, last_seen_at
           from devices where account_id = $1 order by registered_at`,
        [accountId],
      ),
    };
  }
}

/**
 * The check that makes "no secrets" a property rather than an intention.
 *
 * Driven by the register: every column classified `secret` is looked for by
 * name, in both the database's spelling and camelCase, anywhere in the
 * assembled document. A new secret column added to the register is therefore
 * covered the day it is added, without anyone remembering to come back here.
 *
 * It throws rather than filtering. A silent strip would let the export ship
 * with a secret removed by luck; a failure stops the file existing at all.
 */
export function assertNoSecrets(document: unknown): void {
  const forbidden = Object.values(REGISTER)
    .flatMap((columns) => Object.entries(columns))
    .filter(([, rule]) => rule.dataClass === 'secret')
    .map(([column]) => column);

  const serialised = JSON.stringify(document);
  const found = forbidden.filter((column) =>
    serialised.includes(`"${column}"`)
    || serialised.includes(`"${column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())}"`));

  if (found.length > 0) {
    throw new Error(`the export would have contained credential fields: ${found.join(', ')}`);
  }
}

function summarise(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
