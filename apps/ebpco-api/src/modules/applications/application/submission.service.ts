import { SqlClient } from '../../../persistence/sql-client';
import { lookup, remember, requestDigest } from '../../../persistence/idempotency';
import { AuditService } from '../../compliance/application/audit.service';
import { Caller } from '../domain/application';
import { FormViolation, schemaFor } from '../domain/application-form';
import { randomUUID } from 'node:crypto';
import { normaliseEmail } from '../../identity/application/account.repository';
import { unusablePasswordHash } from '../../identity/application/staff-directory.service';
import { RequirementDocument, RequirementsService } from './requirements.service';

/**
 * Filing an application, exactly once.
 *
 * The idempotency key is not decoration here — it is the whole reason this is a
 * service rather than an INSERT. The mobile client queues submissions offline
 * (TAB 12) and replays them when the connection returns, and the case that
 * matters is a submission the server committed whose response was lost. Without
 * the key that replay is a second building permit for the same fence; with it,
 * the applicant gets the original back.
 *
 * The applicant supplies almost nothing that matters. Lifecycle status,
 * classification, charter entry, reference number and the filing timestamp are
 * all set here, from the LGU's own data — a client that could name its own
 * status could file an application already Approved.
 */

export type SubmitResult =
  | {
      readonly ok: true;
      readonly applicationId: string;
      readonly referenceNumber: string;
      /** True when this call did nothing because the same key already had. */
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'no-applicant-record' | 'unknown-permit-type' | 'business-not-yours'
        | 'documents-not-yours' | 'requirement-unknown' | 'key-reused' | 'form-rejected'
        | 'not-a-renewal' | 'renewal-needs-a-permit' | 'permit-not-found';
      readonly detail: string;
      /** Present for `form-rejected`, so a client can point at the field. */
      readonly violations?: readonly FormViolation[];
    };

export interface Submission {
  readonly permitType: string;
  readonly applicationAction: 'New' | 'Renewal' | 'Amendment';
  readonly businessId: string | null;
  readonly location: string | null;
  /**
   * The permit a Renewal or Amendment is about, as printed on the applicant's
   * copy. Null for a New application, and required for the other two — a
   * renewal that names nothing leaves an officer searching for the original by
   * the applicant's name.
   */
  readonly renewsPermitNumber?: string | null;
  readonly documentIds: readonly string[];
  /** The applicant's answers. Structurally bounded by the transport; semantically checked here if a schema exists. */
  readonly form: Record<string, unknown>;
}

export interface NewBusiness {
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

export type OnBehalfResult =
  | { readonly ok: true; readonly applicationId: string; readonly referenceNumber: string;
      readonly applicantId: string; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export class SubmissionService {
  private readonly audit: AuditService;

  private readonly requirements: RequirementsService;

  constructor(
    private readonly db: SqlClient,
    private readonly clock: () => Date = () => new Date(),
    audit?: AuditService,
    requirements?: RequirementsService,
  ) {
    this.audit = audit ?? new AuditService(db, clock);
    this.requirements = requirements ?? new RequirementsService(db, clock, this.audit);
  }

  async submit(options: {
    caller: Caller;
    submission: Submission;
    idempotencyKey: string;
  }): Promise<SubmitResult> {
    const { caller, submission, idempotencyKey } = options;
    // The form is part of the request's identity. Without it, a replay carrying
    // different answers under the same key would be treated as the same
    // submission and the applicant's corrections would be silently discarded.
    const digest = requestDigest({ ...submission, documentIds: [...submission.documentIds].sort() });

    return this.db.transaction(async (tx) => {
      const replay = await lookup<{ applicationId: string; referenceNumber: string }>(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'application.submit', digest,
      });
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'key-reused',
          detail: 'This Idempotency-Key was already used for a different application. Use a new key.',
        };
      }
      if (replay.kind === 'replay') {
        return { ok: true, ...replay.previous.body, replayed: true };
      }

      const applicant = await tx.query<{ id: string }>(
        'select id from applicants where account_id = $1',
        [caller.accountId],
      );
      const applicantId = applicant.rows[0]?.id;
      if (applicantId === undefined) {
        // A staff account, or an applicant account with no applicant record.
        // Refused rather than created on the fly: an applicant record carries a
        // name that belongs on a permit, and inventing one from an email
        // address puts a guess on a legal document.
        return {
          ok: false, reason: 'no-applicant-record',
          detail: 'This account has no applicant profile. Complete your profile before filing.',
        };
      }

      const permitType = await tx.query<{ permit_type: string }>(
        'select permit_type from permit_types where permit_type = $1',
        [submission.permitType],
      );
      if (permitType.rows.length === 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue a "${submission.permitType}" permit.`,
        };
      }

      if (submission.businessId !== null) {
        // Yours, or nothing. Filing against someone else's business would put
        // their registered name and address on your application.
        const owned = await tx.query(
          `select 1 from businesses where id = $1 and owner_applicant_id = $2`,
          [submission.businessId, applicantId],
        );
        if (owned.rows.length === 0) {
          return {
            ok: false, reason: 'business-not-yours',
            detail: 'That business is not registered to this account.',
          };
        }
      }

      if (submission.documentIds.length > 0) {
        // Uploaded by you, and not already attached to another application. The
        // second half matters: without it a document could be pointed at a new
        // filing and disappear from the one an officer is evaluating.
        const mine = await tx.query<{ n: string }>(
          `select count(*) as n from documents
            where id = any($1) and uploaded_by = $2 and application_id is null and deleted_at is null`,
          [[...submission.documentIds], caller.accountId],
        );
        if (Number(mine.rows[0]?.n ?? 0) !== submission.documentIds.length) {
          return {
            ok: false, reason: 'documents-not-yours',
            detail: 'One or more documents are not yours, are already attached to an application, '
              + 'or no longer exist.',
          };
        }
      }

      // Semantic validation, where there is anything to validate against. The
      // registry is empty until the LGU's forms are supplied (M-10), so today
      // this always takes the second branch — and the branch it takes is
      // recorded on the row rather than assumed, so `form_validated_against is
      // null` finds every application filed before there was a schema.
      const schema = schemaFor(submission.permitType);
      if (schema !== undefined) {
        const violations = schema.validate(submission.form);
        if (violations.length > 0) {
          return {
            ok: false,
            reason: 'form-rejected',
            detail: 'Some answers on the form are not valid for this permit type.',
            violations,
          };
        }
      }

      const renewal = await this.resolveRenewal(tx, {
        action: submission.applicationAction,
        permitNumber: submission.renewsPermitNumber ?? null,
        applicantId,
      });
      if (!renewal.ok) return { ok: false, reason: renewal.reason, detail: renewal.detail };

      const now = this.clock();
      const { applicationId, referenceNumber, requiredDocuments } = await this.fileApplication(tx, {
        applicantId, submission, now, renewsPermitId: renewal.permitId,
        // Self-service: the filer and the applicant are the same account.
        filedBy: caller.accountId,
        formValidatedAgainst: schema?.version ?? null,
      });

      if (submission.documentIds.length > 0) {
        // Every requirement code an attached document carries must be on THIS
        // application's checklist (C-6).
        //
        // Checked here rather than at upload because here is the first moment
        // the list exists: `POST /documents` takes a nullable application_id and
        // both clients upload before they file, so at upload time there is no
        // permit type to check against. And it is checked against the list just
        // SNAPSHOTTED onto the application -- the one it will be judged by --
        // not whatever the catalogue says afterwards.
        //
        // Refused rather than quietly nulled. A code naming nothing is a client
        // bug, and dropping it would leave the applicant believing they had
        // answered a requirement they had not.
        const attributed = await tx.query<{ requirement_code: string }>(
          `select distinct requirement_code from documents
            where id = any($1) and requirement_code is not null`,
          [[...submission.documentIds]],
        );
        const onChecklist = new Set(requiredDocuments.map((entry) => entry.code));
        const unknown = attributed.rows
          .map((row) => row.requirement_code)
          .filter((code) => !onChecklist.has(code))
          .sort();
        if (unknown.length > 0) {
          return {
            ok: false, reason: 'requirement-unknown',
            detail: `This permit type has no requirement called ${unknown.join(', ')}.`,
          };
        }

        await tx.query(
          'update documents set application_id = $1 where id = any($2)',
          [applicationId, [...submission.documentIds]],
        );
      }

      await this.audit.append({
        action: 'application.submitted',
        subjectType: 'application',
        subjectId: applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        afterState: { referenceNumber, permitType: submission.permitType },
      }, tx);

      const body = { applicationId, referenceNumber };
      await remember(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'application.submit', digest, status: 201, body,
      });

      return { ok: true, ...body, replayed: false };
    });
  }

  /**
   * The reference number an applicant quotes at a counter.
   *
   * From the same atomic counter the permit numbers use (migration 010), for
   * the same reason: two applications sharing a reference is two filings the
   * LGU cannot tell apart, and counting existing rows collides the moment one
   * did not come from the counter.
   */
  /**
   * Filing for a walk-in, at the counter.
   *
   * ── Why an account always exists ────────────────────────────────────────
   *
   * Not a preference — a constraint. `applicants.account_id` is NOT NULL and
   * UNIQUE, so an applicant record cannot exist without an account, and an
   * account cannot exist without a unique email address. So the open question
   * in the Master Command ("does an account exist for that applicant") is
   * already answered by the schema: it must. What is left is HOW the person
   * later reaches it, and that is the same answer as for a staff account —
   * the account is created with a verifier no password produces, and the
   * applicant claims it through account recovery. An officer who could set that
   * password could file, pay and collect as the applicant.
   *
   * The cost is real and worth stating: an applicant with NO email address
   * cannot be filed for. Synthesising one would create an account nobody can
   * ever claim and a contact address every notice is sent to and nobody reads —
   * a filing the LGU believes it has told someone about. Refusing is the honest
   * failure; making `account_id` nullable is a schema decision, not one to take
   * inside a request handler.
   */
  async fileOnBehalf(options: {
    caller: Caller;
    applicant: { firstName: string; lastName: string; email: string; mobileNumber: string | null };
    business: NewBusiness | null;
    businessId: string | null;
    submission: Pick<Submission, 'permitType' | 'applicationAction' | 'location' | 'form'>;
    renewsPermitNumber?: string | null;
    idempotencyKey: string;
  }): Promise<OnBehalfResult> {
    const { caller, applicant, submission, idempotencyKey } = options;
    const digest = requestDigest({
      ...submission, email: normaliseEmail(applicant.email),
      businessId: options.businessId, business: options.business,
    });

    return this.db.transaction(async (tx) => {
      const replay = await lookup<{ applicationId: string; referenceNumber: string; applicantId: string }>(
        tx, { accountId: caller.accountId, key: idempotencyKey, operation: 'application.on-behalf', digest },
      );
      if (replay.kind === 'mismatch') {
        return {
          ok: false, reason: 'key-reused',
          detail: 'This Idempotency-Key was already used for a different filing. Use a new key.',
        };
      }
      if (replay.kind === 'replay') return { ok: true, ...replay.previous.body, replayed: true };

      const normalised = normaliseEmail(applicant.email);
      const existing = await tx.query<{ id: string; kind: string }>(
        'select id, kind from accounts where email_normalised = $1', [normalised],
      );
      const account = existing.rows[0] ?? null;

      if (account !== null && account.kind === 'staff') {
        // An officer's own account. Attaching an applicant record to it would
        // create an identity that can hold a permit but cannot use the mobile
        // app -- a staff token carries no `applications:write` -- so the person
        // would be stranded between the two populations.
        return {
          ok: false, reason: 'staff-address',
          detail: 'That address belongs to an LGU staff account. File under the applicant\'s own address.',
        };
      }

      let accountId = account?.id ?? null;
      if (accountId === null) {
        accountId = randomUUID();
        await tx.query(
          `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number, created_at, created_by)
           values ($1,'applicant',$2,$3,$4,$5,$6,$7)`,
          [accountId, applicant.email.trim(), normalised, unusablePasswordHash(),
           applicant.mobileNumber, this.clock(), caller.accountId],
        );
      }

      // A RETURNING walk-in keeps their existing applicant record. Creating a
      // second one would split their history across two identities, and the
      // unique constraint on `account_id` refuses it anyway -- better to reuse
      // deliberately than to meet the constraint as a 500.
      const found = await tx.query<{ id: string }>(
        'select id from applicants where account_id = $1', [accountId],
      );
      let applicantId = found.rows[0]?.id ?? null;
      if (applicantId === null) {
        applicantId = randomUUID();
        await tx.query(
          'insert into applicants (id, account_id, first_name, last_name) values ($1,$2,$3,$4)',
          [applicantId, accountId, applicant.firstName.trim(), applicant.lastName.trim()],
        );
      }

      let businessId = options.businessId;
      if (options.business !== null) {
        businessId = randomUUID();
        await tx.query(
          `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                                   province, registration_number, date_registered)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [businessId, applicantId, options.business.name, options.business.category,
           options.business.street, options.business.barangay, options.business.city,
           options.business.province, options.business.registrationNumber,
           options.business.dateRegistered],
        );
      } else if (businessId !== null) {
        // Theirs, or nothing -- the same rule the self-service path enforces.
        // Filing against another applicant's business would put their
        // registered name and address on this application.
        const owned = await tx.query(
          'select 1 from businesses where id = $1 and owner_applicant_id = $2',
          [businessId, applicantId],
        );
        if (owned.rows.length === 0) {
          return {
            ok: false, reason: 'business-not-theirs',
            detail: 'That business is not registered to this applicant.',
          };
        }
      }

      const permitType = await tx.query(
        'select permit_type from permit_types where permit_type = $1', [submission.permitType],
      );
      if (permitType.rows.length === 0) {
        return {
          ok: false, reason: 'unknown-permit-type',
          detail: `The LGU does not issue a "${submission.permitType}" permit.`,
        };
      }

      const renewal = await this.resolveRenewal(tx, {
        action: submission.applicationAction,
        permitNumber: options.renewsPermitNumber ?? null,
        applicantId,
      });
      if (!renewal.ok) return { ok: false, reason: renewal.reason, detail: renewal.detail };

      const now = this.clock();
      const filed = await this.fileApplication(tx, {
        applicantId, now, renewsPermitId: renewal.permitId,
        submission: { ...submission, businessId },
        // THE DISTINCTION. `created_by` is the officer who typed it in;
        // `applicant_id` is whose permit it is. Collapsing them would credit
        // the applicant with an act they did not perform, and lose the only
        // record that the LGU filed on their behalf.
        filedBy: caller.accountId,
        formValidatedAgainst: schemaFor(submission.permitType)?.version ?? null,
      });

      await this.audit.append({
        action: 'application.filed-on-behalf',
        subjectType: 'application',
        subjectId: filed.applicationId,
        outcome: 'allowed',
        actorAccountId: caller.accountId,
        actorRole: 'staff',
        afterState: {
          referenceNumber: filed.referenceNumber,
          permitType: submission.permitType,
          applicantId,
          accountCreated: account === null,
        },
      }, tx);

      const body = { ...filed, applicantId };
      await remember(tx, {
        accountId: caller.accountId, key: idempotencyKey,
        operation: 'application.on-behalf', digest, status: 201, body,
      });
      return { ok: true, ...body, replayed: false };
    });
  }

  /**
   * The permit a Renewal or Amendment is about.
   *
   * Theirs, or nothing. Renewing someone else's permit would put their
   * particulars on this applicant's filing, and it is the same rule the
   * business check enforces one field away — an applicant may only build on
   * records that are already theirs.
   *
   * Resolved from the permit NUMBER the applicant quotes, because that is what
   * is printed on the instrument in their hand; the column stores the key.
   */
  private async resolveRenewal(
    tx: SqlClient,
    options: { action: string; permitNumber: string | null; applicantId: string },
  ): Promise<
    | { ok: true; permitId: string | null }
    | { ok: false; reason: 'not-a-renewal' | 'renewal-needs-a-permit' | 'permit-not-found'; detail: string }
  > {
    const { action, permitNumber, applicantId } = options;

    if (action === 'New') {
      if (permitNumber !== null) {
        return {
          ok: false, reason: 'not-a-renewal',
          detail: 'A New application does not renew a permit. Choose Renewal or Amendment, or omit it.',
        };
      }
      return { ok: true, permitId: null };
    }

    if (permitNumber === null) {
      // The defect the whole column exists to prevent: an officer opening a
      // renewal and having to find the original by searching a name.
      return {
        ok: false, reason: 'renewal-needs-a-permit',
        detail: `A ${action} has to say which permit it is about. Quote the permit number.`,
      };
    }

    const found = await tx.query<{ application_id: string }>(
      `select g.application_id
         from generated_permits g
         join applications a on a.id = g.application_id
        where g.permit_number = $1 and a.applicant_id = $2`,
      [permitNumber, applicantId],
    );
    const permitId = found.rows[0]?.application_id;
    if (permitId === undefined) {
      // One answer for "no such permit" and "not yours", deliberately. Telling
      // them apart would let anyone test whether a permit number exists.
      return {
        ok: false, reason: 'permit-not-found',
        detail: `No permit numbered "${permitNumber}" is registered to this applicant.`,
      };
    }
    return { ok: true, permitId };
  }

  /**
   * The row itself, written the same way however the filing was initiated.
   *
   * Extracted because assisted filing needs it and a second copy would mean two
   * writers to the reference-number sequence and two readings of the Citizen's
   * Charter — one of which would eventually stop matching the other. The only
   * thing that differs between the two callers is `filedBy`, which is exactly
   * the distinction that has to be recorded.
   */
  private async fileApplication(
    tx: SqlClient,
    options: {
      applicantId: string;
      submission: Pick<Submission, 'permitType' | 'applicationAction' | 'location' | 'businessId' | 'form'>;
      now: Date;
      filedBy: string;
      formValidatedAgainst: string | null;
      renewsPermitId: string | null;
    },
  ): Promise<{
    applicationId: string; referenceNumber: string;
    /** The checklist SNAPSHOTTED onto this application -- the list it will be
     *  judged against. Returned so a caller validates against the stored list
     *  rather than re-reading a catalogue that may have moved. */
    requiredDocuments: readonly RequirementDocument[];
  }> {
    const { applicantId, submission, now, filedBy } = options;

    // The charter entry in force ON THE FILING DATE, not the latest one. An
    // application is judged against the pledge that was published when it was
    // filed; re-reading the current entry later would move a deadline the
    // applicant was given.
    const charter = await tx.query<{ id: string; classification: string }>(
      `select id, classification from charter_entries
        where permit_type = $1 and effective_from <= $2::date
          and (effective_to is null or effective_to > $2::date)
        order by effective_from desc limit 1`,
      [submission.permitType, now],
    );
    const charterEntry = charter.rows[0] ?? null;

    // WHAT WAS ASKED OF THIS APPLICATION, captured now. The checklist changes;
    // a filed application must not. Someone who submitted everything required
    // in March cannot become non-compliant in April because the LGU added a
    // document, and an officer looking at this later needs the list it was
    // actually judged against — not whatever the catalogue says today.
    const requirements = await this.requirements.forPermitType(submission.permitType, tx);

    const referenceNumber = await this.nextReference(tx, now);
    const inserted = await tx.query<{ id: string }>(
      `insert into applications
         (reference_number, applicant_id, business_id, permit_type, application_action,
          location, lifecycle_status, classification, charter_entry_id, submitted_at, created_by,
          form, form_validated_against, required_documents, renews_permit_id)
       values ($1,$2,$3,$4,$5,$6,'Submitted',$7,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [
        referenceNumber, applicantId, submission.businessId, submission.permitType,
        submission.applicationAction, submission.location,
        charterEntry?.classification ?? null, charterEntry?.id ?? null, now, filedBy,
        JSON.stringify(submission.form), options.formValidatedAgainst,
        JSON.stringify(requirements), options.renewsPermitId,
      ],
    );
    return { applicationId: inserted.rows[0]?.id ?? '', referenceNumber,
      requiredDocuments: requirements };
  }

  private async nextReference(tx: SqlClient, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const sequence = await tx.query<{ last_issued: number }>(
      `insert into document_number_sequences (series, year, last_issued)
       values ('APP', $1, 1)
       on conflict (series, year)
         do update set last_issued = document_number_sequences.last_issued + 1
       returning last_issued`,
      [year],
    );
    return `E-BPCO-${year}-${String(Number(sequence.rows[0]?.last_issued ?? 1)).padStart(6, '0')}`;
  }
}
