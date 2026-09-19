import { randomUUID } from 'node:crypto';

import { SqlClient } from '../../persistence/sql-client';
import { lookup, remember, requestDigest } from '../../persistence/idempotency';
import { AuditService } from '../compliance/application/audit.service';
import { Caller } from '../applications/domain/application';
import { normaliseEmail } from '../identity/application/account.repository';
import { unusablePasswordHash } from '../identity/application/staff-directory.service';

/**
 * Registering a business at the counter, for an owner who may not yet have
 * an account.
 *
 * This is `SubmissionService.fileOnBehalf`'s account/applicant resolution,
 * lifted out for a caller that wants a business record and nothing else --
 * the Businesses page's own "+ Business" wizard, which used to only ever
 * push a row into this page's local list (see businesses.ts's since-removed
 * `createBusiness`). Same constraint driving the shape (`applicants.account_id`
 * is NOT NULL and UNIQUE, so an owner needs a real, unique email address
 * before a business can be attached to them) and the same reason no password
 * is ever accepted here: an officer who could set the owner's password could
 * later sign in as them. The owner claims the account afterwards through
 * account recovery, exactly as a walk-in filed on behalf of already does.
 */

export interface NewBusinessOwner {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly mobileNumber: string | null;
}

export interface NewStaffBusiness {
  readonly name: string;
  readonly category: string;
  readonly street: string;
  readonly barangay: string;
  readonly city: string;
  readonly province: string;
  readonly registrationNumber: string;
  /** 'YYYY-MM-DD'. */
  readonly dateRegistered: string;
}

export type StaffCreateBusinessResult =
  | {
      readonly ok: true;
      readonly businessId: string;
      readonly applicantId: string;
      readonly accountCreated: boolean;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reason: 'staff-address' | 'key-reused'; readonly detail: string };

export class StaffBusinessRegistrationService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
  }

  async create(options: {
    caller: Caller;
    owner: NewBusinessOwner;
    business: NewStaffBusiness;
    idempotencyKey: string;
  }): Promise<StaffCreateBusinessResult> {
    const { caller, owner, business, idempotencyKey } = options;
    const digest = requestDigest({ owner: { ...owner, email: normaliseEmail(owner.email) }, business });

    return this.db.transaction(async (tx) => {
      const replay = await lookup<{ businessId: string; applicantId: string; accountCreated: boolean }>(
        tx, { accountId: caller.accountId, key: idempotencyKey, operation: 'business.registered-by-staff', digest },
      );
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'key-reused',
          detail: 'This Idempotency-Key was already used for a different registration. Use a new key.',
        };
      }
      if (replay.kind === 'replay') return { ok: true, ...replay.previous.body, replayed: true };

      const normalised = normaliseEmail(owner.email);
      const existing = await tx.query<{ id: string; kind: string }>(
        'select id, kind from accounts where email_normalised = $1', [normalised],
      );
      const account = existing.rows[0] ?? null;

      if (account !== null && account.kind === 'staff') {
        // Same refusal as fileOnBehalf's, for the same reason: an officer's own
        // account cannot also carry an applicant's business.
        return {
          ok: false, reason: 'staff-address',
          detail: 'That address belongs to an LGU staff account. Register the business under the owner\'s own address.',
        };
      }

      let accountId = account?.id ?? null;
      if (accountId === null) {
        accountId = randomUUID();
        await tx.query(
          `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number, created_at, created_by)
           values ($1,'applicant',$2,$3,$4,$5,$6,$7)`,
          [accountId, owner.email.trim(), normalised, unusablePasswordHash(),
           owner.mobileNumber, this.clock(), caller.accountId],
        );
      }

      // A returning owner keeps their existing applicant record -- creating a
      // second one would split their businesses across two identities, and the
      // unique constraint on `account_id` refuses it anyway.
      const found = await tx.query<{ id: string }>(
        'select id from applicants where account_id = $1', [accountId],
      );
      let applicantId = found.rows[0]?.id ?? null;
      if (applicantId === null) {
        applicantId = randomUUID();
        await tx.query(
          'insert into applicants (id, account_id, first_name, last_name) values ($1,$2,$3,$4)',
          [applicantId, accountId, owner.firstName.trim(), owner.lastName.trim()],
        );
      }

      const businessId = randomUUID();
      await tx.query(
        `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                                 province, registration_number, date_registered)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [businessId, applicantId, business.name, business.category, business.street,
         business.barangay, business.city, business.province, business.registrationNumber,
         business.dateRegistered],
      );

      const accountCreated = account === null;
      await this.audit.append({
        action: 'business.registered-by-staff',
        subjectType: 'business',
        subjectId: businessId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: 'staff',
        afterState: { applicantId, accountCreated },
      }, tx);

      const body = { businessId, applicantId, accountCreated };
      await remember(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'business.registered-by-staff', digest, status: 201, body,
      });
      return { ok: true, ...body, replayed: false };
    });
  }
}
