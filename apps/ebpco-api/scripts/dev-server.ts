/**
 * The real API, listening, backed by PGlite.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The closing verdict says the second thing that would change it is "one client
 * calling it", and that has been impossible on a machine with no PostgreSQL and
 * no Docker. This boots the ACTUAL application — the same `createApp` main.ts
 * uses, the same guards, the same routes — against PGlite, which is real
 * PostgreSQL compiled to WebAssembly and the same engine every test here runs
 * on. Migrations run against it; constraints and triggers are the real ones.
 *
 * So a portal pointed at this is genuinely calling the API. What it is NOT is a
 * deployment: the database lives in this process and dies with it, and every
 * account below has a known password.
 *
 * ── The safety that matters ─────────────────────────────────────────────
 *
 * It refuses to start unless `EBPCO_ENVIRONMENT` is `development`. Seed accounts
 * with published passwords are exactly the thing that must never be reachable
 * from anywhere real, and a guard that depends on somebody remembering is not a
 * guard.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { PasswordHasher } from '../src/modules/identity/domain/password-hasher';
import { StaffRole, MFA_REQUIRED_ROLES } from '../src/modules/identity/domain/account';
import { normaliseEmail } from '../src/modules/identity/application/account.repository';
import { TotpService } from '../src/modules/identity/application/totp.service';
import { SecretBox } from '../src/modules/identity/domain/secret-box';
import { codeFor, stepAt } from '../src/modules/identity/domain/totp';

/** Local QA account, added alongside the existing dev roster below it. */
const QA_EMAIL = 'QA@lguids.com.ph';

const say = (line = ''): void => void process.stdout.write(`${line}\n`);

/**
 * Generated per run, printed once, and never written down.
 *
 * It was a constant in this file until the secret scanner saw it — correctly:
 * a password literal in tracked source is a password in every clone and every
 * fork of a public repository, whatever the comment beside it says. Random per
 * run is strictly better and costs a line: nothing can hardcode it, and a
 * screenshot of a terminal is the worst it can leak into.
 */
const PASSWORD = randomBytes(9).toString('base64url');

const STAFF: ReadonlyArray<{ email: string; role: StaffRole }> = [
  { email: QA_EMAIL, role: 'super-admin' },
  { email: 'super@lgu.gov.ph', role: 'super-admin' },
  { email: 'admin@lgu.gov.ph', role: 'administrator' },
  { email: 'records@lgu.gov.ph', role: 'records-officer' },
  { email: 'evaluator@lgu.gov.ph', role: 'evaluator' },
  { email: 'assessor@lgu.gov.ph', role: 'assessor' },
  { email: 'cashier@lgu.gov.ph', role: 'cashier' },
  { email: 'official@lgu.gov.ph', role: 'building-official' },
  { email: 'releasing@lgu.gov.ph', role: 'releasing-officer' },
  { email: 'auditor@lgu.gov.ph', role: 'auditor' },
];

async function seed(
  db: SqlClient, hasher: PasswordHasher,
): Promise<{ qaAccountId: string; staffAccountIds: ReadonlyMap<string, string> }> {
  const hash = await hasher.hash(PASSWORD);
  let qaAccountId = '';
  const staffAccountIds = new Map<string, string>();

  for (const { email, role } of STAFF) {
    const id = randomUUID();
    if (email === QA_EMAIL) qaAccountId = id;
    staffAccountIds.set(email, id);
    // email_normalised must actually be normalised — authenticate() looks accounts
    // up by normaliseEmail(input), which lowercases. Every entry above happened to
    // already be lowercase; QA_EMAIL is the first one that isn't, and reusing the
    // raw literal here would silently make this account unable to sign in.
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff',$2,$3,$4)`,
      [id, email, normaliseEmail(email), hash],
    );
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
    // Every MFA_REQUIRED_ROLES account is enrolled+activated in main() below,
    // right after this function returns — verifyTotp fails closed with no
    // secret enrolled, so a seeded account in one of those roles and nothing
    // else could never sign in (see D-10 / seed-super-admin.ts).
    //
    // Visibility is ALSO gated on a `staff_access` row (formsFor() in
    // staff-queue.service.ts: no row at all means null access, which means
    // EVERY permit type is filtered out regardless of staff_permit_access —
    // "no assignment row means no access, never all access"). Migration 032
    // added this gate after this seed already existed; nothing here ever
    // gave any staff account (QA included) that row, so every staff account
    // saw an empty queue no matter its role or scopes. Every seeded staff
    // account gets 'view-edit' here so a real (non-QA) role can be tested at
    // all — matching seed-super-admin.ts's own grant to the real super admin.
    await db.query(
      'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
      [id, 'view-edit'],
    );
    if (email === QA_EMAIL) {
      // Visibility is gated on granted permit types (an officer assigned none
      // sees nothing), and nothing here grants any by default — the seeded
      // applications below would otherwise be invisible through /staff/applications
      // even though they exist. Same grant seed-super-admin.ts gives the real
      // account, scoped to QA_EMAIL only.
      await db.query(
        `insert into staff_permit_access (account_id, permit_type, granted_by)
         select $1, permit_type, $1 from permit_types where retired_at is null`,
        [id],
      );
    } else {
      // Every other seeded staff account gets the one permit type the seed
      // below actually files applications under — enough to test its own
      // role's real actions against real data, without the blanket grant
      // QA gets (QA's own account is the only one meant to see everything).
      await db.query(
        `insert into staff_permit_access (account_id, permit_type, granted_by)
         values ($1,'Fencing Permit',$1)`,
        [id],
      );
    }
  }

  // One applicant with a business and a few applications spread across the
  // lifecycle, so a queue has something in it and the statuses differ. Walked
  // through legal transitions rather than inserted at a status: the database
  // refuses an application born anywhere but Draft or Submitted.
  const account = randomUUID();
  const applicant = randomUUID();
  const business = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash, mobile_number)
     values ($1,'applicant','maria@example.ph','maria@example.ph',$2,'+639171234567')`,
    [account, hash],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [applicant, account],
  );
  await db.query(
    `insert into businesses (id, owner_applicant_id, name, category, street, barangay, city,
                             province, registration_number, date_registered)
     values ($1,$2,'Santos Sari-Sari Store','Retail','12 Rizal Street','Poblacion','Castilla',
             'Sorsogon','BN-2024-0001','2024-03-01')`,
    [business, applicant],
  );

  const path: Record<string, readonly string[]> = {
    'Submitted': [],
    'Received': ['Received'],
    'Document Verification': ['Received', 'Document Verification'],
    'Under Evaluation': ['Received', 'Document Verification', 'Under Evaluation'],
    'Revision Required': ['Received', 'Document Verification', 'Revision Required'],
    // Walked all the way to Approved (bypassing the real per-step service
    // validation the same way every row above does) so Stage 4's
    // generate/prepare-release/release chain has a real Approved+Paid
    // application to exercise without a lengthy multi-role manual walk
    // through evaluation and assessment first.
    'Approved': [
      'Received', 'Document Verification', 'Under Evaluation', 'Assessed',
      'Payment Submitted', 'Payment Under Verification', 'Payment Verified',
      'For Approval', 'Approved',
    ],
  };
  let sequence = 0;
  const idByStatus = new Map<string, string>();
  for (const [status, steps] of Object.entries(path)) {
    sequence += 1;
    const id = randomUUID();
    idByStatus.set(status, id);
    await db.query(
      `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                                 application_action, lifecycle_status, location, submitted_at, created_by)
       values ($1,$2,$3,$4,'Fencing Permit','New','Submitted',$5, now(), $6)`,
      [id, `E-BPCO-2026-${String(sequence).padStart(6, '0')}`, applicant, business,
       `${sequence * 10} Rizal Street, Poblacion`, account],
    );
    for (const step of steps) {
      await db.query('update applications set lifecycle_status = $1 where id = $2', [step, id]);
    }
  }

  // The Approved row above needs a real, verified Order of Payment too — the
  // frontend's own same-tick "Generate Permit" hint checks paymentStatus ===
  // 'Paid' alongside lifecycleStatus === 'Approved', and the queue derives
  // paymentStatus from a genuinely verified `payments` row, not the
  // lifecycle status alone.
  {
    const approvedId = idByStatus.get('Approved')!;
    const assessorId = staffAccountIds.get('assessor@lgu.gov.ph')!;
    const cashierId = staffAccountIds.get('cashier@lgu.gov.ph')!;
    const orderId = randomUUID();
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos,
         processing_centavos, architectural_centavos, structural_centavos, electrical_centavos,
         others_centavos, total_centavos, fee_schedule_version, assessed_by)
       values ($1,$2,'OP-2026-000001',50000,120000,0,0,0,0,170000,'2026.1',$3)`,
      [orderId, approvedId, assessorId],
    );
    await db.query(
      `insert into payments (id, order_of_payment_id, application_id, reference_number,
         amount_centavos, method, status, submitted_by, verified_at, verified_by,
         official_receipt_number)
       values ($1,$2,$3,'PAY-2026-000001',170000,'Onsite','Paid',$4,now(),$5,'OR-2026-000001')`,
      [randomUUID(), orderId, approvedId, account, cashierId],
    );
  }

  // The rows above use hand-picked reference numbers instead of the real
  // `nextReference()` sequence (submission.service.ts), which reads/writes
  // `document_number_sequences('APP', <year>)`. Without this, that sequence
  // never learns those numbers were taken, so the first REAL filing after
  // this seed runs collides with a seeded row on the exact same
  // "E-BPCO-2026-000001" — every dev-server run, not just occasionally.
  await db.query(
    `insert into document_number_sequences (series, year, last_issued)
     values ('APP', 2026, $1)
     on conflict (series, year) do update set last_issued = excluded.last_issued`,
    [sequence],
  );

  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  for (const [line, amount] of [['filing', 50_000], ['processing', 120_000], ['structural', 512_000]] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1','Fencing Permit',$1,$2,'City Ordinance 2026-004 s.3')`,
      [line, amount],
    );
  }

  return { qaAccountId, staffAccountIds };
}

async function main(): Promise<void> {
  const config = loadConfig({
    EBPCO_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused@in-process/pglite',
    OBJECT_STORE_ENDPOINT: 'https://objects.invalid',
    OBJECT_STORE_BUCKET: 'ebpco-documents',
    OBJECT_STORE_LOCAL_PATH: resolve(__dirname, '../.dev-objects'),
    MALWARE_SCANNER_URL: 'http://scanner.invalid:3310',
    JWT_SIGNING_KEY: 'a-development-signing-key-of-at-least-32-chars',
    PASSWORD_PEPPER: 'a-development-pepper-of-at-least-32-characters',
    TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
    PUSH_TOKEN_ENCRYPTION_KEY: 'a-test-push-key-of-at-least-32-characters',
    RATE_LIMIT_MAX: '10000',
    PORT: process.env.PORT ?? '3000',
    // The real environment wins, and the guard below REFUSES anything that is
    // not development. Forcing it instead would be worse: run on a machine
    // where EBPCO_ENVIRONMENT says production, a silent override would seed
    // accounts with a published password there and report success.
    ...process.env,
  });

  if (config.EBPCO_ENVIRONMENT !== 'development') {
    throw new Error(
      `refusing to start: EBPCO_ENVIRONMENT is "${config.EBPCO_ENVIRONMENT}". `
      + 'This server seeds accounts with a published password and is for development only.',
    );
  }

  const logger = new StructuredLogger('info', (line) => say(line));
  const db = await PgliteClient.create();
  await migrate(db, loadMigrations(resolve(__dirname, '../db/migrations')));
  const { staffAccountIds } = await seed(db, new PasswordHasher(undefined, config.PASSWORD_PEPPER));

  // Every MFA_REQUIRED_ROLES account is enrolled+activated the same way
  // seed-super-admin.ts does for the real deployment, so sign-in actually
  // succeeds instead of failing closed on a missing factor. Previously only
  // QA_EMAIL was enrolled — assessor/cashier/building-official/releasing-
  // officer/administrator/super-admin (super@lgu.gov.ph) could never sign in
  // at all, which blocks testing anything gated on `staff:assess`/
  // `staff:verify-payment`/etc. with a real (non-QA) account.
  const totp = new TotpService(
    db,
    new SecretBox(config.TOTP_ENCRYPTION_KEY),
    `eBPCO ${config.EBPCO_ENVIRONMENT}`,
  );
  const mfaEnrolled: { email: string; uri: string }[] = [];
  for (const { email, role } of STAFF) {
    if (!MFA_REQUIRED_ROLES.includes(role)) continue;
    const accountId = staffAccountIds.get(email)!;
    const offer = await totp.begin({ accountId });
    if (!offer.ok) throw new Error(`could not begin MFA enrolment for ${email}: ${offer.detail}`);
    const activated = await totp.activate({
      accountId,
      code: codeFor(offer.value.secret, stepAt(new Date())),
    });
    if (!activated.ok) throw new Error(`could not activate MFA for ${email}: ${activated.detail}`);
    mfaEnrolled.push({ email, uri: offer.value.uri });
  }

  const app = await createApp(config, logger, db);
  await app.listen({ port: config.PORT, host: '127.0.0.1' });

  say('');
  say(`  eBPCO API (development) — http://127.0.0.1:${config.PORT}`);
  say('  PGlite, in this process. The database dies when this does.');
  say('');
  say(`  password for every account below: ${PASSWORD}`);
  for (const { email, role } of STAFF) say(`    ${email.padEnd(26)} ${role}`);
  say(`    ${'maria@example.ph'.padEnd(26)} applicant`);
  say('');
  say('  These accounts require MFA. Scan each into an authenticator app now —');
  say('  every secret below is generated fresh this run and shown once:');
  say('');
  for (const { email, uri } of mfaEnrolled) {
    say(`    ${email}`);
    say(`      ${uri}`);
  }
  say('');
  say('  Use the code AFTER the one your app shows right now for each — activation just spent the current step.');
  say('');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
