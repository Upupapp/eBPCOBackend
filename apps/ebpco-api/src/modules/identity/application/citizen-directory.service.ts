import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { lookup, remember, requestDigest } from '../../../persistence/idempotency';
import { TokenService } from './token.service';
import { RectificationService, RectificationResult } from './rectification.service';
import { ErasureService, ErasureReceipt } from '../../compliance/application/erasure.service';
import { AccountRecoveryMailer } from './account-recovery-mailer';
import { IdentityService } from './identity.service';

/**
 * The Citizens module: a citizen account (`accounts.kind = 'applicant'`,
 * joined to `applicants`), as staff administer it.
 *
 * Deliberately its OWN service, not an extension of `StaffDirectoryService`.
 * That class's every query is `where a.kind = 'staff'` and its whole shape —
 * roles, MFA enrolment, the super-admin floor — answers questions that make
 * no sense for a citizen. Reaching into it for `sessionsOf`/`revokeSession`
 * would technically run (those two queries do not filter by kind), but
 * borrowing a STAFF directory's methods for a CITIZEN screen is exactly the
 * vocabulary confusion the module's own brief exists to end — "citizen" and
 * "staff" are two populations with two directories, and this file is the
 * second one.
 *
 * ── Why mutations are not delegated to StaffDirectoryService's shape ────────
 *
 * `disable`/`enable` here write `accounts.disabled_reason` (migration 049),
 * a column the staff directory's table has no equivalent for and does not
 * select. `sessions` here revokes an account's ENTIRE session set in one
 * call — the product requirement ("Sign out all sessions") — where the staff
 * directory only ever revoked one family at a time by id.
 *
 * ── Why rectification and erasure ARE delegated, unmodified ────────────────
 *
 * `RectificationService.rectify()` and `ErasureService.erase()` already
 * resolve the two hardest questions here — which fields are correctable
 * (never the sign-in email) and what survives an erasure request under PD
 * 1096 — and duplicating either would be a second place either rule could
 * drift from the self-service routes that already enforce it
 * (`MeController.rectify`/`erase` in auth.controller.ts). Both already write
 * their own audit entry attributed to the ACCOUNT acted on (self-service has
 * no other actor to name); this service adds a SECOND, staff-attributed
 * entry recording who at the LGU initiated it and why, rather than changing
 * either service's signature to carry an actor override it has never needed
 * before today.
 *
 * Neither delegate call runs inside this service's own idempotency
 * transaction. Both open their OWN transaction on the same `SqlClient`
 * (`this.db`), and nesting a second `db.transaction()` inside an
 * already-open one is exactly what `rectification.service.ts`'s own comment
 * warns against: against PGlite, which serves a single connection, the
 * inner call simply hangs until the request times out — not a hypothetical,
 * the identical shape of bug this codebase has already hit once. So the
 * idempotency record for those two mutations is written in its OWN
 * statement, immediately after the delegate's transaction has already
 * committed, rather than atomically with it. `RectificationService` and
 * `ErasureService` are already safe to retry (rectifying the same fields
 * twice is a no-op the second time; `erase()` is explicitly idempotent and
 * returns the same receipt), so a lost idempotency row here costs a
 * harmless retry, not a duplicated effect.
 */

export interface CitizenListRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly mobileVerified: boolean;
  readonly status: 'active' | 'disabled';
  readonly registeredAt: string;
  readonly businessCount: number;
  readonly applicationCount: number;
}

export interface CitizenMetrics {
  readonly total: number;
  readonly active: number;
  readonly disabled: number;
  readonly emailVerified: number;
  readonly mobileVerified: number;
  readonly newLast30Days: number;
}

export interface CitizenSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  /**
   * Always null today. A refresh-token family is not linked to a `devices`
   * row anywhere in this schema — `devices` carries `account_id` and a
   * platform, not a `family_id` — so there is no real value to report here.
   * Left in the shape (rather than dropped) because the field is genuine
   * product intent the schema does not yet support, and `null` says that
   * honestly; inventing one from the account's most-recent `devices` row
   * would attribute one session's platform to a possibly different one.
   * Recorded as a human decision in CITIZENS-HANDOFF.md.
   */
  readonly device: string | null;
}

export interface CitizenAuditEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorAccountId: string | null;
  readonly actorRole: string | null;
}

export interface CitizenDetail extends CitizenListRow {
  readonly mobileNumber: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly middleName: string | null;
  readonly street: string | null;
  readonly barangay: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly dateOfBirth: string | null;
  readonly sex: string | null;
  readonly civilStatus: string | null;
  readonly nationality: string | null;
  readonly businesses: ReadonlyArray<{ readonly id: string; readonly name: string; readonly status: string }>;
  readonly applications: ReadonlyArray<{
    readonly id: string; readonly referenceNumber: string; readonly permitType: string;
    readonly lifecycleStatus: string; readonly submittedAt: string | null;
  }>;
  readonly sessions: readonly CitizenSession[];
  readonly auditEntries: readonly CitizenAuditEntry[];
}

export type CitizenRefusal =
  | { readonly ok: false; readonly reason: 'not-found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'key-reused'; readonly detail: string };

export type CitizenRectifyResult =
  | { readonly ok: true; readonly mobileVerificationCleared: boolean }
  | CitizenRefusal
  | { readonly ok: false; readonly reason: 'no-profile'; readonly detail: string };

export type CitizenEraseResult =
  | { readonly ok: true; readonly receipt: ErasureReceipt }
  | CitizenRefusal
  | { readonly ok: false; readonly reason: 'staff-account'; readonly detail: string };

export type CitizenResetLinkResult =
  | { readonly ok: true; readonly delivery: 'sent' | 'not-sent' | 'failed'; readonly detail: string }
  | CitizenRefusal;

interface ListRow {
  id: string; first_name: string; last_name: string; email: string;
  email_verified_at: Date | null; mobile_verified_at: Date | null; disabled_at: Date | null;
  created_at: Date; business_count: number; application_count: number;
}

/**
 * Named columns only — never `a.*`/`ap.*`. The same discipline
 * `staff-businesses.controller.ts` documents: a column added to `accounts`
 * or `applicants` for an unrelated feature must not be broadcast to every
 * officer's browser by default.
 */
const LIST_SELECT = `
  select a.id, ap.first_name, ap.last_name, a.email,
         a.email_verified_at, a.mobile_verified_at, a.disabled_at, a.created_at,
         (select count(*)::int from businesses b where b.owner_applicant_id = ap.id) as business_count,
         (select count(*)::int from applications app where app.applicant_id = ap.id) as application_count
    from accounts a
    join applicants ap on ap.account_id = a.id
   where a.kind = 'applicant'
`;

function listRow(row: ListRow): CitizenListRow {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    mobileVerified: row.mobile_verified_at !== null,
    status: row.disabled_at !== null ? 'disabled' : 'active',
    registeredAt: row.created_at.toISOString(),
    businessCount: row.business_count,
    applicationCount: row.application_count,
  };
}

const UUID = /^[0-9a-fA-F-]{36}$/;

export class CitizenDirectoryService {
  constructor(
    private readonly db: SqlClient,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly identity: IdentityService,
    private readonly rectification: RectificationService,
    private readonly erasure: ErasureService,
    private readonly recoveryMailer: AccountRecoveryMailer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(options: {
    search?: string; status?: 'active' | 'disabled'; verified?: boolean;
    page: number; pageSize: number;
  }): Promise<{ rows: readonly CitizenListRow[]; page: number; pageSize: number; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (options.status !== undefined) {
      where.push(options.status === 'disabled' ? 'a.disabled_at is not null' : 'a.disabled_at is null');
    }
    if (options.verified !== undefined) {
      where.push(options.verified ? 'a.email_verified_at is not null' : 'a.email_verified_at is null');
    }
    if (options.search !== undefined && options.search.trim() !== '') {
      // Escaped, not merely parameterised — `%`/`_` are ILIKE wildcards
      // wherever they come from, the same defect `staff-businesses
      // .controller.ts`'s own `list()` was written to fix.
      const escaped = options.search.trim().replace(/([\\%_])/g, '\\$1');
      const term = bind(`%${escaped}%`);
      where.push(
        `(ap.first_name ilike ${term} escape '\\' or ap.last_name ilike ${term} escape '\\' `
        + `or a.email ilike ${term} escape '\\' or a.mobile_number ilike ${term} escape '\\')`,
      );
    }

    const clause = where.length > 0 ? `and ${where.join(' and ')}` : '';
    const page = Math.max(1, options.page);
    const pageSize = Math.min(Math.max(1, options.pageSize), 200);
    const offset = (page - 1) * pageSize;

    const counted = await this.db.query<{ total: number }>(
      `select count(*)::int as total from accounts a join applicants ap on ap.account_id = a.id
        where a.kind = 'applicant' ${clause}`,
      values,
    );
    const total = counted.rows[0]?.total ?? 0;

    const limitParam = bind(pageSize);
    const offsetParam = bind(offset);
    const rows = await this.db.query<ListRow>(
      `${LIST_SELECT} ${clause} order by ap.last_name, ap.first_name limit ${limitParam} offset ${offsetParam}`,
      values,
    );

    return { rows: rows.rows.map(listRow), page, pageSize, total };
  }

  async metrics(): Promise<CitizenMetrics> {
    const result = await this.db.query<{
      total: number; active: number; disabled: number;
      email_verified: number; mobile_verified: number; new_last_30_days: number;
    }>(
      `select
         count(*)::int as total,
         count(*) filter (where a.disabled_at is null)::int as active,
         count(*) filter (where a.disabled_at is not null)::int as disabled,
         count(*) filter (where a.email_verified_at is not null)::int as email_verified,
         count(*) filter (where a.mobile_verified_at is not null)::int as mobile_verified,
         count(*) filter (where a.created_at >= $1)::int as new_last_30_days
       from accounts a
       join applicants ap on ap.account_id = a.id
      where a.kind = 'applicant'`,
      [new Date(this.clock().getTime() - 30 * 24 * 60 * 60 * 1000)],
    );
    const row = result.rows[0]!;
    return {
      total: row.total,
      active: row.active,
      disabled: row.disabled,
      emailVerified: row.email_verified,
      mobileVerified: row.mobile_verified,
      newLast30Days: row.new_last_30_days,
    };
  }

  /**
   * The one call every route below shares, so "does this id resolve to a
   * citizen" is answered identically everywhere: a staff account id, or one
   * that does not exist at all, is 404 — "not found as not yours", the same
   * posture `staff-directory.controller.ts`'s own doc comment describes for
   * the symmetric case.
   */
  async byId(citizenId: string): Promise<{ row: ListRow } | null> {
    if (!UUID.test(citizenId)) return null;
    const result = await this.db.query<ListRow>(`${LIST_SELECT} and a.id = $1`, [citizenId]);
    const row = result.rows[0];
    return row === undefined ? null : { row };
  }

  /**
   * Reads personal data, so it is audited in its own right (NPC Circular
   * 16-01 covers who VIEWED a record, not only who changed one) — the same
   * requirement `audit.service.ts`'s own module doc comment states for a
   * document read or an export.
   */
  async detail(citizenId: string, actor: { accountId: string; role: string }): Promise<CitizenDetail | null> {
    const found = await this.byId(citizenId);
    if (found === null) return null;
    const { row } = found;

    const [profile, businesses, applications, sessions, history] = await Promise.all([
      this.db.query<{
        mobile_number: string | null; disabled_reason: string | null;
        middle_name: string | null; street: string | null; barangay: string | null;
        city: string | null; province: string | null; postal_code: string | null;
        date_of_birth: string | null; sex: string | null; civil_status: string | null;
        nationality: string | null;
      }>(
        `select a.mobile_number, a.disabled_reason, ap.middle_name, ap.street, ap.barangay,
                ap.city, ap.province, ap.postal_code,
                ap.date_of_birth,
                ap.sex, ap.civil_status, ap.nationality
           from accounts a join applicants ap on ap.account_id = a.id
          where a.id = $1`,
        [citizenId],
      ),
      this.db.query<{ id: string; name: string; status: string }>(
        `select b.id, b.name, b.status from businesses b
           join applicants ap on ap.id = b.owner_applicant_id
          where ap.account_id = $1
          order by b.name`,
        [citizenId],
      ),
      this.db.query<{
        id: string; reference_number: string; permit_type: string;
        lifecycle_status: string; submitted_at: Date | null;
      }>(
        `select app.id, app.reference_number, app.permit_type, app.lifecycle_status, app.submitted_at
           from applications app
           join applicants ap on ap.id = app.applicant_id
          where ap.account_id = $1
          order by app.created_at desc`,
        [citizenId],
      ),
      this.sessionsOf(citizenId),
      // Reuses AuditService.historyOf — the same method `staff/audit/:subjectType/:id`
      // is built on — rather than a second query against `audit_events`.
      this.audit.historyOf('account', citizenId),
    ]);
    const p = profile.rows[0]!;

    // The read itself, audited. Awaited, so a view is never reported to the
    // caller as having happened before it was actually recorded.
    await this.audit.append({
      action: 'citizen.viewed',
      subjectType: 'account',
      subjectId: citizenId,
      outcome: 'allowed',
      actorAccountId: actor.accountId,
      actorRole: actor.role,
    });

    return {
      ...listRow(row),
      mobileNumber: p.mobile_number,
      disabledAt: row.disabled_at === null ? null : row.disabled_at.toISOString(),
      disabledReason: p.disabled_reason,
      middleName: p.middle_name,
      street: p.street,
      barangay: p.barangay,
      city: p.city,
      province: p.province,
      postalCode: p.postal_code,
      dateOfBirth: p.date_of_birth,
      sex: p.sex,
      civilStatus: p.civil_status,
      nationality: p.nationality,
      businesses: businesses.rows,
      applications: applications.rows.map((a) => ({
        id: a.id,
        referenceNumber: a.reference_number,
        permitType: a.permit_type,
        lifecycleStatus: a.lifecycle_status,
        submittedAt: a.submitted_at === null ? null : a.submitted_at.toISOString(),
      })),
      sessions,
      auditEntries: history.slice(0, 50).map((entry) => ({
        sequence: entry.sequence,
        occurredAt: entry.occurredAt.toISOString(),
        action: entry.action,
        outcome: entry.outcome,
        actorAccountId: entry.actorAccountId,
        actorRole: entry.actorRole,
      })),
    };
  }

  /** The sessions an applicant currently holds. Same shape as `StaffDirectoryService.sessionsOf`. */
  async sessionsOf(citizenId: string): Promise<readonly CitizenSession[]> {
    const result = await this.db.query<{
      family_id: string; issued_at: Date; last_used_at: Date | null;
    }>(
      `select t.family_id, min(t.issued_at) as issued_at, max(t.consumed_at) as last_used_at
         from refresh_tokens t
    left join revoked_sessions r on r.family_id = t.family_id
        where t.account_id = $1
          and t.revoked_at is null
          and r.family_id is null
          and t.expires_at > $2
     group by t.family_id
     order by min(t.issued_at) desc`,
      [citizenId, this.clock()],
    );
    return result.rows.map((row) => ({
      id: row.family_id,
      createdAt: row.issued_at.toISOString(),
      lastSeenAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
      device: null,
    }));
  }

  /**
   * Idempotency for a mutation that does its OWN direct writes (no delegate
   * service with its own transaction) — lookup, run, remember, all inside
   * one transaction, the same shape
   * `staff-business-registration.service.ts`'s own `create()` uses.
   */
  private async withOwnTransaction<T extends Record<string, unknown>>(
    options: { actor: string; key: string; operation: string; body: unknown },
    run: (tx: SqlClient) => Promise<{ ok: true; body: T } | CitizenRefusal>,
  ): Promise<{ ok: true; body: T; replayed: boolean } | CitizenRefusal> {
    const digest = requestDigest(options.body);
    return this.db.transaction(async (tx) => {
      const replay = await lookup<T>(
        tx, { accountId: options.actor, key: options.key, operation: options.operation, digest },
      );
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'key-reused',
          detail: 'This Idempotency-Key was already used for a different request. Use a new key.',
        } as const;
      }
      if (replay.kind === 'replay') return { ok: true, body: replay.previous.body, replayed: true };

      const outcome = await run(tx);
      if (!outcome.ok) return outcome;

      await remember(tx, {
        accountId: options.actor, key: options.key, operation: options.operation,
        digest, status: 200, body: outcome.body,
      });
      return { ok: true, body: outcome.body, replayed: false };
    });
  }

  /**
   * Idempotency for a mutation that delegates to a service with its OWN
   * transaction (`RectificationService`/`ErasureService`) — see this file's
   * module comment for why `remember` cannot share that transaction.
   */
  private async withDelegateTransaction<T extends Record<string, unknown>, R extends { readonly reason: string; readonly detail: string }>(
    options: { actor: string; key: string; operation: string; body: unknown },
    run: () => Promise<{ ok: true; body: T } | ({ ok: false } & R)>,
  ): Promise<
    | { ok: true; body: T; replayed: boolean }
    | ({ ok: false } & R)
    | { readonly ok: false; readonly reason: 'key-reused'; readonly detail: string }
  > {
    const digest = requestDigest(options.body);
    const replay = await lookup<T>(
      this.db, { accountId: options.actor, key: options.key, operation: options.operation, digest },
    );
    if (replay.kind === 'mismatch') {
      return {
        ok: false, reason: 'key-reused',
        detail: 'This Idempotency-Key was already used for a different request. Use a new key.',
      };
    }
    if (replay.kind === 'replay') return { ok: true, body: replay.previous.body, replayed: true };

    const outcome = await run();
    if (!outcome.ok) return outcome;

    await remember(this.db, {
      accountId: options.actor, key: options.key, operation: options.operation,
      digest, status: 200, body: outcome.body,
    });
    return { ok: true, body: outcome.body, replayed: false };
  }

  async revokeAllSessions(options: {
    citizenId: string; actor: { accountId: string; role: string };
    reason: string; idempotencyKey: string;
  }): Promise<{ ok: true; revoked: number; replayed: boolean } | CitizenRefusal> {
    const found = await this.byId(options.citizenId);
    if (found === null) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };

    // `withDelegateTransaction`, not `withOwnTransaction`: `TokenService
    // .endAllSessions` calls `SessionRepository.revokeAllForAccount`, which
    // opens its OWN `db.transaction()` (see that method's own implementation)
    // — exactly the nested-transaction shape this file's module comment
    // warns about for `RectificationService`/`ErasureService`, and just as
    // fatal against PGlite's single connection if it ran inside this
    // service's own idempotency transaction instead of sequentially after it.
    const outcome = await this.withDelegateTransaction<
      { revoked: number }, { readonly reason: 'not-found'; readonly detail: string }
    >(
      {
        actor: options.actor.accountId, key: options.idempotencyKey,
        operation: 'citizen.sessions.revoked', body: { citizenId: options.citizenId, reason: options.reason },
      },
      async () => {
        // The same revocation mechanism `TokenService.endAllSessions` gives
        // `POST /auth/revoke { allSessions: true }` — called directly rather
        // than through `IdentityService.signOutEverywhere`, whose own
        // security entry (`endedSession`) hardcodes `actorAccountId` to the
        // account being signed out. That is correct for a citizen signing
        // themself out and wrong here: a STAFF member did this, to someone
        // else's account, for a stated reason, and the audit entry has to
        // say so.
        const revoked = await this.tokens.endAllSessions(options.citizenId);
        await this.audit.append({
          action: 'citizen.sessions.revoked',
          subjectType: 'account',
          subjectId: options.citizenId,
          outcome: 'allowed',
          actorAccountId: options.actor.accountId,
          actorRole: options.actor.role,
          afterState: { revoked, reason: options.reason },
        });
        return { ok: true, body: { revoked } };
      },
    );
    if (!outcome.ok) return outcome;
    return { ok: true, revoked: outcome.body.revoked, replayed: outcome.replayed };
  }

  async setDisabled(options: {
    citizenId: string; disabled: boolean; actor: { accountId: string; role: string };
    reason: string; idempotencyKey: string;
  }): Promise<{ ok: true; replayed: boolean } | CitizenRefusal> {
    const found = await this.byId(options.citizenId);
    if (found === null) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };
    const before = found.row.disabled_at !== null;

    const outcome = await this.withOwnTransaction<Record<string, never>>(
      {
        actor: options.actor.accountId, key: options.idempotencyKey,
        operation: options.disabled ? 'citizen.disabled' : 'citizen.enabled',
        body: { citizenId: options.citizenId, reason: options.reason },
      },
      async (tx) => {
        await tx.query(
          `update accounts set disabled_at = $1, disabled_reason = $2, updated_at = $3 where id = $4`,
          [
            options.disabled ? this.clock() : null,
            options.disabled ? options.reason : null,
            this.clock(), options.citizenId,
          ],
        );
        await this.audit.append({
          action: options.disabled ? 'citizen.disabled' : 'citizen.enabled',
          subjectType: 'account',
          subjectId: options.citizenId,
          outcome: 'allowed',
          actorAccountId: options.actor.accountId,
          actorRole: options.actor.role,
          beforeState: { disabled: before },
          afterState: { disabled: options.disabled, reason: options.reason },
        }, tx);
        return { ok: true, body: {} };
      },
    );
    if (!outcome.ok) return outcome;

    // Disabling takes effect on the account's next request regardless
    // (`AccountStatusReader.standingOf` reads `disabled_at` fresh every
    // time) — sessions are revoked as well so an ALREADY-OPEN tab is cut off
    // immediately too, not just refused the next time it tries to sign in.
    // Best-effort and outside the transaction above on purpose: a
    // revocation failure must not silently undo a disable that already
    // committed and was already reported to the caller.
    if (options.disabled) await this.tokens.endAllSessions(options.citizenId).catch(() => undefined);

    return { ok: true, replayed: outcome.replayed };
  }

  async sendPasswordResetLink(options: {
    citizenId: string; actor: { accountId: string; role: string };
    reason: string; idempotencyKey: string;
  }): Promise<CitizenResetLinkResult> {
    const found = await this.byId(options.citizenId);
    if (found === null) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };
    const email = found.row.email;

    // `withDelegateTransaction`, not `withOwnTransaction`: `IdentityService
    // .beginPasswordReset` calls `PasswordResetRepository.issue`, which opens
    // its OWN `db.transaction()` — the same nested-transaction shape this
    // file's module comment warns about, and just as fatal against PGlite's
    // single connection if run inside this service's own idempotency
    // transaction instead of sequentially after it.
    const outcome = await this.withDelegateTransaction<
      { delivery: 'sent' | 'not-sent' | 'failed'; detail: string },
      { readonly reason: 'not-found'; readonly detail: string }
    >(
      {
        actor: options.actor.accountId, key: options.idempotencyKey,
        operation: 'citizen.password-reset-link', body: { citizenId: options.citizenId, reason: options.reason },
      },
      async () => {
        // Same ticket TTL and mailer as `POST /auth/password/forgot` — this
        // does not reimplement account recovery, it triggers the existing
        // one on the citizen's behalf. Unlike that route, this is not
        // anti-enumeration (the officer is looking at the account already),
        // so the outcome is reported honestly rather than always 202.
        const ticket = await this.identity.beginPasswordReset(email);
        let delivery: 'sent' | 'not-sent' | 'failed' = 'not-sent';
        let detail = 'The LGU has no message provider configured yet, so no link has been sent.';
        if (ticket !== null) {
          if (this.recoveryMailer.real) {
            try {
              await this.recoveryMailer.sendPasswordSetupLink(email, ticket);
              delivery = 'sent';
              detail = 'A password-setup link was sent to the citizen’s email address.';
            } catch {
              delivery = 'failed';
              detail = 'The link was generated, but the email could not be sent just now. Try again in a moment.';
            }
          }
        }
        await this.audit.append({
          action: 'citizen.password-reset-link-sent',
          subjectType: 'account',
          subjectId: options.citizenId,
          outcome: 'allowed',
          actorAccountId: options.actor.accountId,
          actorRole: options.actor.role,
          afterState: { delivery, reason: options.reason },
        });
        return { ok: true, body: { delivery, detail } };
      },
    );
    if (!outcome.ok) return outcome;
    return { ok: true, delivery: outcome.body.delivery, detail: outcome.body.detail };
  }

  async rectify(options: {
    citizenId: string; actor: { accountId: string; role: string }; reason: string; idempotencyKey: string;
    // `| undefined` explicitly on every field, matching
    // `rectification.service.ts`'s own doc comment on why: `exactOptionalPropertyTypes`
    // is on, and the zod-parsed body this is built from carries absent
    // fields as present-and-undefined, not as omitted keys.
    changes: {
      firstName?: string | undefined; middleName?: string | null | undefined;
      lastName?: string | undefined; mobileNumber?: string | undefined;
      street?: string | null | undefined; barangay?: string | null | undefined;
      city?: string | null | undefined; province?: string | null | undefined;
      postalCode?: string | null | undefined;
    };
  }): Promise<CitizenRectifyResult> {
    const found = await this.byId(options.citizenId);
    if (found === null) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };

    const before = await this.snapshotForRectification(options.citizenId);

    const outcome = await this.withDelegateTransaction<
      { mobileVerificationCleared: boolean }, { readonly reason: 'no-profile'; readonly detail: string }
    >(
      {
        actor: options.actor.accountId, key: options.idempotencyKey,
        operation: 'citizen.rectified',
        body: { citizenId: options.citizenId, reason: options.reason, changes: options.changes },
      },
      async () => {
        const result: RectificationResult = await this.rectification.rectify({
          accountId: options.citizenId, ...options.changes,
        });
        if (!result.ok) {
          return { ok: false as const, reason: 'no-profile', detail: result.detail };
        }
        // A SECOND entry, staff-attributed — `RectificationService.rectify`
        // already wrote its own `profile.rectified` entry attributed to the
        // account itself (the only actor self-service ever has). This one
        // names who at the LGU did it, why, and what changed, which the
        // first entry deliberately omits (see that method's own comment on
        // why values are not in ITS entry).
        const after = await this.snapshotForRectification(options.citizenId);
        await this.audit.append({
          action: 'citizen.rectified',
          subjectType: 'account',
          subjectId: options.citizenId,
          outcome: 'allowed',
          actorAccountId: options.actor.accountId,
          actorRole: options.actor.role,
          beforeState: before,
          afterState: { ...after, reason: options.reason },
        });
        return { ok: true, body: { mobileVerificationCleared: result.mobileVerificationCleared } };
      },
    );
    if (!outcome.ok) return outcome;
    return { ok: true, mobileVerificationCleared: outcome.body.mobileVerificationCleared };
  }

  private async snapshotForRectification(citizenId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query<{
      first_name: string; middle_name: string | null; last_name: string; mobile_number: string | null;
      street: string | null; barangay: string | null; city: string | null; province: string | null;
      postal_code: string | null;
    }>(
      `select ap.first_name, ap.middle_name, ap.last_name, a.mobile_number,
              ap.street, ap.barangay, ap.city, ap.province, ap.postal_code
         from applicants ap join accounts a on a.id = ap.account_id
        where ap.account_id = $1`,
      [citizenId],
    );
    return { ...rows.rows[0] };
  }

  async erase(options: {
    citizenId: string; actor: { accountId: string; role: string }; reason: string;
    requestReference: string; idempotencyKey: string;
  }): Promise<CitizenEraseResult> {
    const found = await this.byId(options.citizenId);
    if (found === null) return { ok: false, reason: 'not-found', detail: 'No such citizen account.' };

    const outcome = await this.withDelegateTransaction<
      { receipt: ErasureReceipt }, { readonly reason: 'not-found' | 'staff-account'; readonly detail: string }
    >(
      {
        actor: options.actor.accountId, key: options.idempotencyKey,
        operation: 'citizen.erasure',
        body: { citizenId: options.citizenId, reason: options.reason, requestReference: options.requestReference },
      },
      async () => {
        // A first entry naming WHO asked and under what reference, BEFORE
        // calling the service that does the erasing — `ErasureService.erase`
        // is not bypassed (it still runs its own transaction, its own
        // deletes in order, and its own unmodified `account.erased` entry);
        // this is the staff-initiated request that entry has no way to
        // name, recorded as its own act rather than as a parameter smuggled
        // into a self-service method that has never needed one.
        await this.audit.append({
          action: 'citizen.erasure.requested',
          subjectType: 'account',
          subjectId: options.citizenId,
          outcome: 'allowed',
          actorAccountId: options.actor.accountId,
          actorRole: options.actor.role,
          afterState: { reason: options.reason, requestReference: options.requestReference },
        });
        const result = await this.erasure.erase(options.citizenId);
        if (!result.ok) {
          return { ok: false as const, reason: result.reason, detail: result.detail };
        }
        return { ok: true, body: { receipt: result.receipt } };
      },
    );
    if (!outcome.ok) return outcome;
    return { ok: true, receipt: outcome.body.receipt };
  }
}
