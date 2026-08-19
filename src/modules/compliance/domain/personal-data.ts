/**
 * Every column in this database, classified.
 *
 * RA 10173 and NPC Circular 16-01 require a personal information controller to
 * know what personal data it holds, why, and for how long. A register is how
 * that question gets an answer that is checkable rather than remembered.
 *
 * The important property is not the classification itself — it is that the
 * register is **complete**. A test compares it against the live schema and
 * fails if any column is in neither list, so a new column must be classified to
 * merge. Without that, "we tagged the personal data" means "we tagged the
 * personal data we thought of", and the difference between the two is invisible
 * until a breach notification has to enumerate what was disclosed.
 *
 * The nineteen `pii:` comments in the migrations remain and are cross-checked
 * against this file. They are for whoever is reading the schema directly; this
 * is for the code that has to act on it.
 */

/**
 * What kind of thing a column is, from the data subject's point of view.
 *
 * `linkable` is the class people forget. An account id identifies nobody on its
 * own, and it ties every record in this database to one person — so erasing a
 * name while keeping the id everywhere leaves a fully linkable trail and an
 * erasure that did not erase.
 */
export type DataClass =
  /** Identifies a person on its own: a name, an address, an email, an IP. */
  | 'direct'
  /** A pseudonymous key that ties records to a person. */
  | 'linkable'
  /** Authentication material about a person. Never disclosed, never exported. */
  | 'secret'
  /** Supplied by a person and may contain anything, including more of the above. */
  | 'content'
  /** Not about a person at all. */
  | 'none';

/**
 * How long it is kept, and what an erasure request can do to it.
 *
 * The conflict this exists to make explicit: RA 10173 gives a data subject the
 * right to erasure, and PD 1096 and the LGU's own records rules require permit
 * records to be kept. Both are true. Pretending otherwise — by deleting a
 * permit record on request, or by refusing every request because "we keep
 * records" — is how an LGU ends up in breach of one law or the other.
 */
export type Retention =
  /** Goes when the account goes. */
  | 'account-lifetime'
  /** Kept regardless of an erasure request. The basis must be named. */
  | 'statutory'
  /** A short working window; purged on a schedule whether or not anyone asks. */
  | 'operational'
  /** The audit chain. Append-only by construction; erasing an entry breaks it. */
  | 'audit';

export interface ColumnRule {
  readonly dataClass: DataClass;
  readonly retention: Retention;
  /** Required for anything not `none`: why the LGU may hold it. */
  readonly basis?: string;
}

type TableRegister = Readonly<Record<string, ColumnRule>>;

const none = (retention: Retention = 'operational'): ColumnRule => ({ dataClass: 'none', retention });

/** Structural columns that identify a row rather than a person. */
const structural = none('operational');

/**
 * A key that ties rows to one person. Kept for as long as the record it points
 * at, which is why the retention differs per table rather than per class.
 */
const linkable = (retention: Retention, basis: string): ColumnRule =>
  ({ dataClass: 'linkable', retention, basis });

const direct = (retention: Retention, basis: string): ColumnRule =>
  ({ dataClass: 'direct', retention, basis });

const content = (retention: Retention, basis: string): ColumnRule =>
  ({ dataClass: 'content', retention, basis });

const secret = (basis: string): ColumnRule =>
  ({ dataClass: 'secret', retention: 'account-lifetime', basis });

const PERMIT_RECORD = 'PD 1096 and the LGU records schedule: a permit record is evidence '
  + 'that a structure was authorised, and outlives the applicant’s relationship with the LGU';
const SERVICE_DELIVERY = 'performance of a public task (RA 11032 service delivery)';
const ACCOUNTABILITY = 'accountability under NPC Circular 16-01 — who did what to whose record';

export const REGISTER: Readonly<Record<string, TableRegister>> = {
  accounts: {
    id: linkable('account-lifetime', SERVICE_DELIVERY),
    kind: none('account-lifetime'),
    email: direct('account-lifetime', SERVICE_DELIVERY),
    email_normalised: direct('account-lifetime', 'derived from email, same basis'),
    password_hash: secret('authentication'),
    mobile_number: direct('account-lifetime', 'second verification channel (ADR 0004)'),
    email_verified_at: none('account-lifetime'),
    mobile_verified_at: none('account-lifetime'),
    totp_secret_encrypted: secret('authentication'),
    disabled_at: none('account-lifetime'),
    erased_at: none('account-lifetime'),
    created_at: none('account-lifetime'),
    updated_at: none('account-lifetime'),
    created_by: linkable('account-lifetime', ACCOUNTABILITY),
    updated_by: linkable('account-lifetime', ACCOUNTABILITY),
  },

  account_roles: {
    account_id: linkable('account-lifetime', 'authorisation'),
    role: none('account-lifetime'),
    granted_at: none('account-lifetime'),
    granted_by: linkable('audit', ACCOUNTABILITY),
  },

  applicants: {
    id: linkable('statutory', PERMIT_RECORD),
    account_id: linkable('statutory', PERMIT_RECORD),
    // Not account-lifetime. The name on a permit is part of the permit.
    first_name: direct('statutory', PERMIT_RECORD),
    last_name: direct('statutory', PERMIT_RECORD),
    created_at: none('statutory'),
    updated_at: none('statutory'),
  },

  businesses: {
    id: structural,
    owner_applicant_id: linkable('statutory', PERMIT_RECORD),
    name: direct('statutory', PERMIT_RECORD),
    category: none('statutory'),
    // Frequently a home address. Treated as personal data whatever the column
    // is called.
    street: direct('statutory', PERMIT_RECORD),
    barangay: direct('statutory', PERMIT_RECORD),
    city: direct('statutory', PERMIT_RECORD),
    province: direct('statutory', PERMIT_RECORD),
    registration_number: direct('statutory', PERMIT_RECORD),
    date_registered: none('statutory'),
    status: none('statutory'),
    created_at: none('statutory'),
    updated_at: none('statutory'),
  },

  applications: {
    id: structural,
    reference_number: linkable('statutory', PERMIT_RECORD),
    applicant_id: linkable('statutory', PERMIT_RECORD),
    business_id: structural,
    permit_type: none('statutory'),
    application_action: none('statutory'),
    location: direct('statutory', PERMIT_RECORD),
    lifecycle_status: none('statutory'),
    classification: none('statutory'),
    charter_entry_id: structural,
    pledge_suspended_since: none('statutory'),
    version: structural,
    submitted_at: none('statutory'),
    created_at: none('statutory'),
    updated_at: none('statutory'),
    created_by: linkable('statutory', ACCOUNTABILITY),
    updated_by: linkable('statutory', ACCOUNTABILITY),
  },

  application_transitions: {
    id: structural,
    application_id: structural,
    from_status: none('statutory'),
    to_status: none('statutory'),
    occurred_at: none('statutory'),
    actor_account_id: linkable('statutory', ACCOUNTABILITY),
    office: none('statutory'),
    // An officer writes these and an applicant reads them. Free text.
    remarks: content('statutory', PERMIT_RECORD),
  },

  documents: {
    id: structural,
    application_id: structural,
    uploaded_by: linkable('statutory', ACCOUNTABILITY),
    label: none('statutory'),
    // Applicants routinely name files after themselves.
    file_name: content('statutory', PERMIT_RECORD),
    content_type: none('statutory'),
    byte_size: none('statutory'),
    sha256: none('statutory'),
    storage_key: structural,
    status: none('statutory'),
    scan_cleared: none('statutory'),
    scanned_at: none('statutory'),
    expires_on: none('statutory'),
    uploaded_at: none('statutory'),
    deleted_at: none('statutory'),
  },

  evaluations: {
    id: structural,
    application_id: structural,
    stage: none('statutory'),
    result: none('statutory'),
    evaluator_id: linkable('statutory', ACCOUNTABILITY),
    remarks: content('statutory', PERMIT_RECORD),
    evaluated_at: none('statutory'),
  },

  letters_of_instruction: {
    id: structural,
    application_id: structural,
    issued_at: none('statutory'),
    issued_by: linkable('statutory', ACCOUNTABILITY),
    closed_at: none('statutory'),
  },

  instruction_items: {
    id: structural,
    letter_id: structural,
    subject: none('statutory'),
    remark: content('statutory', PERMIT_RECORD),
    resolved_at: none('statutory'),
    response: content('statutory', PERMIT_RECORD),
    response_document_id: structural,
  },

  inspections: {
    id: structural,
    application_id: structural,
    scheduled_at: none('statutory'),
    offices: none('statutory'),
    checklist: none('statutory'),
    outcome: none('statutory'),
    remarks: content('statutory', PERMIT_RECORD),
    completed_at: none('statutory'),
  },

  orders_of_payment: {
    id: structural,
    application_id: structural,
    number: none('statutory'),
    filing_centavos: none('statutory'),
    processing_centavos: none('statutory'),
    architectural_centavos: none('statutory'),
    structural_centavos: none('statutory'),
    electrical_centavos: none('statutory'),
    others_centavos: none('statutory'),
    total_centavos: none('statutory'),
    fee_schedule_version: none('statutory'),
    assessed_at: none('statutory'),
    assessed_by: linkable('statutory', ACCOUNTABILITY),
    due_date: none('statutory'),
    supersedes_id: structural,
    superseded_reason: content('statutory', PERMIT_RECORD),
    superseded_at: none('statutory'),
  },

  payments: {
    id: structural,
    order_of_payment_id: structural,
    application_id: structural,
    // A bank reference ties a person to an account at a named institution.
    reference_number: direct('statutory', 'RA 7160 local treasury accounting'),
    amount_centavos: none('statutory'),
    method: none('statutory'),
    status: none('statutory'),
    proof_document_id: structural,
    submitted_at: none('statutory'),
    submitted_by: linkable('statutory', ACCOUNTABILITY),
    verified_at: none('statutory'),
    verified_by: linkable('statutory', ACCOUNTABILITY),
    official_receipt_number: none('statutory'),
  },

  generated_permits: {
    application_id: structural,
    permit_number: none('statutory'),
    issued_date: none('statutory'),
    scope: none('statutory'),
    conditions: none('statutory'),
    generated_by: linkable('statutory', ACCOUNTABILITY),
  },

  permit_releases: {
    application_id: structural,
    status: none('statutory'),
    method: none('statutory'),
    // Proof of who took the document. The whole point of recording it.
    claimant_name: direct('statutory', PERMIT_RECORD),
    releasing_officer: linkable('statutory', ACCOUNTABILITY),
    released_at: none('statutory'),
    claim_location: none('statutory'),
    office_hours: none('statutory'),
    bring_with_you: none('statutory'),
  },

  notifications: {
    id: structural,
    account_id: linkable('account-lifetime', SERVICE_DELIVERY),
    type: none('account-lifetime'),
    application_id: structural,
    title: content('account-lifetime', SERVICE_DELIVERY),
    body: content('account-lifetime', SERVICE_DELIVERY),
    deep_link: none('account-lifetime'),
    created_at: none('account-lifetime'),
    read_at: none('account-lifetime'),
    resolved_at: none('account-lifetime'),
    dispatched_at: none('account-lifetime'),
  },

  notification_deliveries: {
    id: structural,
    notification_id: structural,
    channel: none('account-lifetime'),
    status: none('account-lifetime'),
    deferred_until: none('account-lifetime'),
    attempted_at: none('account-lifetime'),
    attempts: none('account-lifetime'),
    failure_detail: content('account-lifetime', 'delivery diagnosis'),
  },

  notification_preferences: {
    account_id: linkable('account-lifetime', SERVICE_DELIVERY),
    muted_categories: none('account-lifetime'),
    quiet_hours_enabled: none('account-lifetime'),
    quiet_hours_start: none('account-lifetime'),
    quiet_hours_end: none('account-lifetime'),
    updated_at: none('account-lifetime'),
  },

  devices: {
    id: structural,
    account_id: linkable('account-lifetime', SERVICE_DELIVERY),
    // A device platform and version narrow an individual; on their own they are
    // not identifying, but attached to an account id they are part of the
    // person's record.
    platform: none('account-lifetime'),
    push_token_digest: secret('push delivery'),
    push_token_encrypted: secret('push delivery'),
    app_version: none('account-lifetime'),
    locale: none('account-lifetime'),
    registered_at: none('account-lifetime'),
    last_seen_at: none('account-lifetime'),
  },

  refresh_tokens: {
    id: structural,
    family_id: structural,
    account_id: linkable('operational', 'session management'),
    secret_digest: secret('session management'),
    issued_at: none('operational'),
    expires_at: none('operational'),
    consumed_at: none('operational'),
    revoked_at: none('operational'),
  },

  password_reset_tickets: {
    token_digest: secret('password reset'),
    account_id: linkable('operational', 'password reset'),
    issued_at: none('operational'),
    expires_at: none('operational'),
    used_at: none('operational'),
  },

  idempotency_keys: {
    key: structural,
    account_id: linkable('operational', 'do-this-once'),
    operation: none('operational'),
    request_digest: none('operational'),
    response_status: none('operational'),
    // May echo whatever the response carried.
    response_body: content('operational', 'do-this-once'),
    created_at: none('operational'),
  },

  audit_events: {
    // `structural` would be wrong here: it carries an operational retention,
    // and an audit row purged on an operational schedule breaks the chain. Every
    // column in these two tables is audit-class, including the ids.
    id: none('audit'),
    occurred_at: none('audit'),
    actor_account_id: linkable('audit', ACCOUNTABILITY),
    actor_role: none('audit'),
    action: none('audit'),
    subject_type: none('audit'),
    subject_id: linkable('audit', ACCOUNTABILITY),
    outcome: none('audit'),
    correlation_id: none('audit'),
    // An IP address identifies a person.
    source_address: direct('audit', ACCOUNTABILITY),
    before_state: content('audit', ACCOUNTABILITY),
    after_state: content('audit', ACCOUNTABILITY),
    previous_hash: none('audit'),
    entry_hash: none('audit'),
    sequence: none('audit'),
  },

  audit_chain_head: {
    id: none('audit'),
    last_hash: none('audit'),
    last_sequence: none('audit'),
  },

  // ---- Reference data. About the LGU's process, not about any person. -------

  permit_types: { permit_type: none(), service_domain: none() },
  lifecycle_statuses: {
    status: none(), sequence: none(), terminal: none(),
    applicant_status: none(), requires_applicant_action: none(),
  },
  lifecycle_transitions: { from_status: none(), to_status: none() },
  notification_types: {
    type: none(), category: none(), requires_action: none(), server_generated: none(),
  },
  charter_entries: {
    id: none(), permit_type: none(), classification: none(), pledged_working_days: none(),
    effective_from: none(), effective_to: none(), fee_schedule_version: none(), legal_basis: none(),
  },
  fee_schedules: {
    version: none(), effective_from: none(), effective_to: none(),
    // The ordinance that published it, not a person.
    published_by: none(), created_at: none(),
  },
  fee_schedule_entries: {
    version: none(), permit_type: none(), line: none(), amount_centavos: none(), basis: none(),
  },
  holiday_calendars: { year: none(), complete: none() },
  holidays: {
    year: none(), holiday_date: none(), name: none(), kind: none(), proclamation: none(),
  },
  document_number_sequences: { series: none(), year: none(), last_issued: none() },
  schema_migrations: { version: none(), name: none(), checksum: none(), applied_at: none() },
};

/** Every column that holds something about a person, with its class and basis. */
export function personalDataColumns(): ReadonlyArray<{
  table: string; column: string; rule: ColumnRule;
}> {
  return Object.entries(REGISTER).flatMap(([table, columns]) =>
    Object.entries(columns)
      .filter(([, rule]) => rule.dataClass !== 'none')
      .map(([column, rule]) => ({ table, column, rule })),
  );
}

/** Columns whose retention is tied to the account rather than to a statutory record. */
export function accountLifetimeColumns(): ReadonlyArray<{ table: string; column: string }> {
  return personalDataColumns()
    .filter(({ rule }) => rule.retention === 'account-lifetime')
    .map(({ table, column }) => ({ table, column }));
}
