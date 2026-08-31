import { randomUUID } from 'node:crypto';

import { SqlClient } from '../../../persistence/sql-client';
import { AuditService } from '../../compliance/application/audit.service';
import { StaffRole } from '../domain/account';
import { AccessLevel } from '../domain/staff-access';
import { normaliseEmail } from './account.repository';
import { unusablePasswordHash } from './staff-directory.service';

/**
 * Becoming staff is a REQUEST, never a registration.
 *
 * `/auth/register` mints an applicant with no roles and that does not change.
 * This is the only other public write in the service, and it deliberately
 * cannot create an account: it records that someone asked, and a super admin
 * decides. A request that could become an account by itself would be a sign-up
 * form for staff privileges with extra steps.
 *
 * ── Why the answer is always the same ───────────────────────────────────
 *
 * `raise` returns nothing a caller can read a fact from. Whether the address is
 * already an account, already has a pending request, or is unknown, the caller
 * gets the same acknowledgement — matching `/auth/register`, and for the same
 * reason: an endpoint that answers differently tells anyone who asks which
 * addresses belong to LGU staff, which is a target list.
 */

export interface AccessRequestInput {
  readonly fullName: string;
  readonly email: string;
  readonly mobile: string;
  readonly officePosition: string;
  readonly permitTypes: readonly string[];
  readonly requestedLevel: AccessLevel;
  readonly justification: string;
}

export interface PendingRequest {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly mobile: string;
  readonly officePosition: string;
  readonly requestedLevel: AccessLevel;
  readonly justification: string;
  readonly permitTypes: readonly string[];
  readonly raisedAt: Date;
}

export interface ApprovalInput {
  readonly roles: readonly StaffRole[];
  readonly level: AccessLevel;
  /** Internal permit-type keys. Empty is refused: it would create a useless account. */
  readonly permitTypes: readonly string[];
}

export type Refusal = { readonly ok: false; readonly reason: string; readonly detail: string };
export type Decision<T> = { readonly ok: true; readonly value: T } | Refusal;

/** Per address and per IP. Both, because either alone is trivially defeated. */
const WINDOW_MINUTES = 60;
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

export class AccessRequestService {
  constructor(
    private readonly db: SqlClient,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Record that someone asked.
   *
   * Returns void on every path that is not a caller-input error. There is
   * nothing for a caller to learn here, and any branch that returned something
   * different would be the oracle this endpoint exists to avoid.
   */
  async raise(input: AccessRequestInput, sourceAddress: string): Promise<void> {
    const normalised = normaliseEmail(input.email);

    // The attempt is recorded BEFORE the limit is judged, so an attacker's
    // traffic counts against them even when it is refused. Recording only
    // accepted attempts makes the limit unreachable.
    await this.db.query(
      'insert into access_request_attempts (email_normalised, ip_address) values ($1,$2)',
      [normalised, sourceAddress],
    );

    if (await this.overLimit(normalised, sourceAddress)) return;

    // A duplicate is silently absorbed rather than refused: `on conflict do
    // nothing` against the one-open-per-address index. The caller cannot tell a
    // second request from a first, which is the point.
    const inserted = await this.db.query<{ id: string }>(
      `insert into access_requests (full_name, email, email_normalised, mobile,
                                    office_position, requested_level, justification)
       select $1,$2,$3,$4,$5,$6,$7
        where not exists (
          select 1 from access_requests
           where email_normalised = $3 and status = 'pending')
       returning id`,
      [input.fullName.trim(), input.email.trim(), normalised, input.mobile.trim(),
       input.officePosition.trim(), input.requestedLevel, input.justification.trim()],
    );

    const id = inserted.rows[0]?.id;
    if (id === undefined) return;

    for (const permitType of new Set(input.permitTypes)) {
      await this.db.query(
        'insert into access_request_permit_types (request_id, permit_type) values ($1,$2)',
        [id, permitType],
      );
    }

    await this.audit.append({
      action: 'access.requested',
      subjectType: 'access-request',
      subjectId: id,
      outcome: 'allowed',
      // Nobody is signed in. The actor is the request itself, and pretending
      // otherwise would put a null where an accountable name belongs.
      actorAccountId: null,
      actorRole: null,
      sourceAddress,
      afterState: {
        requestedLevel: input.requestedLevel,
        permitTypes: [...new Set(input.permitTypes)],
        officePosition: input.officePosition.trim(),
      },
    });
  }

  private async overLimit(normalised: string, sourceAddress: string): Promise<boolean> {
    const since = new Date(this.clock().getTime() - WINDOW_MINUTES * 60 * 1000);
    const { rows } = await this.db.query<{ by_email: number; by_ip: number }>(
      `select
         (select count(*)::int from access_request_attempts
           where email_normalised = $1 and at >= $3) as by_email,
         (select count(*)::int from access_request_attempts
           where ip_address = $2 and at >= $3) as by_ip`,
      [normalised, sourceAddress, since],
    );
    const counts = rows[0];
    if (counts === undefined) return false;
    return counts.by_email > MAX_PER_EMAIL || counts.by_ip > MAX_PER_IP;
  }

  /** The queue a super admin works. Cursor-paged: `raised_at, id` is stable. */
  async pending(limit: number, after?: { raisedAt: Date; id: string }): Promise<PendingRequest[]> {
    const { rows } = await this.db.query<{
      id: string; full_name: string; email: string; mobile: string;
      office_position: string; requested_level: AccessLevel; justification: string;
      raised_at: Date;
    }>(
      `select id, full_name, email, mobile, office_position, requested_level,
              justification, raised_at
         from access_requests
        where status = 'pending'
          and ($2::timestamptz is null or (raised_at, id) > ($2, $3::uuid))
        order by raised_at, id
        limit $1`,
      [limit, after?.raisedAt ?? null, after?.id ?? null],
    );

    const requests: PendingRequest[] = [];
    for (const row of rows) {
      const types = await this.db.query<{ permit_type: string }>(
        'select permit_type from access_request_permit_types where request_id = $1 order by permit_type',
        [row.id],
      );
      requests.push({
        id: row.id, fullName: row.full_name, email: row.email, mobile: row.mobile,
        officePosition: row.office_position, requestedLevel: row.requested_level,
        justification: row.justification, raisedAt: row.raised_at,
        permitTypes: types.rows.map((t) => t.permit_type),
      });
    }
    return requests;
  }

  /**
   * Approve: create the account AND its assignment, or neither.
   *
   * One transaction, never user-first-permissions-later. An account that exists
   * for a moment with no allow-list is an account that can sign in and see
   * nothing — which is the SAFE direction, but it is also an account nobody
   * decided to create at that level, and the audit row would claim otherwise.
   */
  async approve(
    requestId: string, approval: ApprovalInput,
    actor: { accountId: string; role: string },
  ): Promise<Decision<{ accountId: string }>> {
    if (approval.permitTypes.length === 0) {
      // An empty allow-list fails closed everywhere else in this system, so
      // approving into one would create an account that can reach nothing. Say
      // so rather than creating it.
      return {
        ok: false, reason: 'no-forms',
        detail: 'Assign at least one permit type. An empty allow-list grants nothing.',
      };
    }
    if (approval.roles.length === 0) {
      return {
        ok: false, reason: 'no-roles', detail: 'Assign at least one staff role.',
      };
    }

    const found = await this.db.query<{ email: string; email_normalised: string; status: string }>(
      'select email, email_normalised, status from access_requests where id = $1', [requestId]);
    const request = found.rows[0];
    if (request === undefined || request.status !== 'pending') {
      return {
        ok: false, reason: 'not-pending',
        detail: 'That request is not open.',
      };
    }

    const taken = await this.db.query<{ id: string }>(
      'select id from accounts where email_normalised = $1', [request.email_normalised]);
    if (taken.rows.length > 0) {
      return {
        ok: false, reason: 'email-taken',
        detail: 'An account already uses that address. Adjust the existing account instead.',
      };
    }

    const accountId = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into accounts (id, kind, email, email_normalised, password_hash, created_at)
         values ($1,'staff',$2,$3,$4,$5)`,
        // Unusable by construction: the account holder must complete a password
        // reset before they can sign in, which is forced rotation without a
        // flag anyone can forget to set.
        [accountId, request.email, request.email_normalised, unusablePasswordHash(), this.clock()],
      );
      for (const role of approval.roles) {
        await tx.query('insert into account_roles (account_id, role) values ($1,$2)',
          [accountId, role]);
      }
      await tx.query(
        'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$3)',
        [accountId, approval.level, actor.accountId]);
      for (const permitType of new Set(approval.permitTypes)) {
        await tx.query(
          'insert into staff_permit_access (account_id, permit_type, granted_by) values ($1,$2,$3)',
          [accountId, permitType, actor.accountId]);
      }
      await tx.query(
        `update access_requests
            set status = 'approved', decided_at = $2, decided_by = $3, created_account_id = $4
          where id = $1`,
        [requestId, this.clock(), actor.accountId, accountId]);

      await this.audit.append({
        action: 'access.approved',
        subjectType: 'account',
        subjectId: accountId,
        outcome: 'allowed',
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        beforeState: null,
        afterState: {
          requestId, roles: approval.roles, level: approval.level,
          permitTypes: [...new Set(approval.permitTypes)],
        },
      }, tx);
    });

    return { ok: true, value: { accountId } };
  }

  /**
   * Reject, with a reason that is mandatory and never returned to the requester.
   *
   * The reason is for the record and for the next super admin to read. What the
   * requester is told is that their request was not approved — a rejection that
   * explained itself would disclose which addresses are known, which roles
   * exist, and what the LGU considers a good enough justification.
   */
  async reject(
    requestId: string, reason: string, actor: { accountId: string; role: string },
  ): Promise<Decision<void>> {
    if (reason.trim().length < 3) {
      return { ok: false, reason: 'reason-required', detail: 'Say why it was refused.' };
    }

    const updated = await this.db.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `update access_requests
            set status = 'rejected', decided_at = $2, decided_by = $3, decision_reason = $4
          where id = $1 and status = 'pending'
          returning id`,
        [requestId, this.clock(), actor.accountId, reason.trim()],
      );
      if (result.rows.length === 0) return false;

      await this.audit.append({
        action: 'access.rejected',
        subjectType: 'access-request',
        subjectId: requestId,
        outcome: 'denied',
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        afterState: { reason: reason.trim() },
      }, tx);
      return true;
    });

    return updated
      ? { ok: true, value: undefined }
      : { ok: false, reason: 'not-pending', detail: 'That request is not open.' };
  }
}
