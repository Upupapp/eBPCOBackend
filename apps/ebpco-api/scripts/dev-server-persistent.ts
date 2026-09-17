/**
 * The same dev roster as `dev-server.ts`, backed by PGlite persisted to a
 * real directory on disk instead of pure in-memory.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * `dev-server.ts`'s whole point is "the database lives in this process and
 * dies with it" — exactly right for a quick check, exactly wrong for a
 * multi-day walkthrough (citizen files something, staff act on it over
 * several sessions) where a restart for an unrelated reason must not erase
 * everything filed so far.
 *
 * The fix is not a separate PostgreSQL server: this machine has neither
 * PostgreSQL nor Docker installed, and installing PostgreSQL needs
 * administrator rights this account does not have (its installer's silent
 * mode still elevates, and a headless elevation prompt just hangs forever).
 * PGlite itself already solves this — it is real PostgreSQL compiled to
 * WebAssembly, and its Node filesystem backend (`NodeFS`) can write its data
 * files to a real directory instead of memory. Passing a `dataDir` to
 * `PgliteClient.create()` is the entire difference from `dev-server.ts`.
 *
 * Same seed roster, same accounts, same TOTP enrolment, made idempotent: it
 * seeds ONCE, the first time it finds an empty database, and every run after
 * that just starts the app against whatever is already on disk. `migrate()`
 * is safe to call every boot (it only applies migrations not yet recorded in
 * `schema_migrations`), so schema upgrades still happen automatically; the
 * seed data itself does not get re-inserted or reset.
 *
 * Still development-only, same as `dev-server.ts`, and refuses to start
 * otherwise for the same reason: these are published, known passwords.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

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
 * Generated once, the first time this database is seeded, and then WRITTEN
 * to `.dev-persistent-credentials.json` (gitignored) — unlike
 * `dev-server.ts`'s password, this one has to survive being read back after
 * the process exits, because the whole point of this script is that the
 * database — and therefore this password's hash — outlives the process.
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
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff',$2,$3,$4)`,
      [id, email, normaliseEmail(email), hash],
    );
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
    await db.query(
      'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
      [id, 'view-edit'],
    );
    if (email === QA_EMAIL) {
      await db.query(
        `insert into staff_permit_access (account_id, permit_type, granted_by)
         select $1, permit_type, $1 from permit_types where retired_at is null`,
        [id],
      );
    } else {
      await db.query(
        `insert into staff_permit_access (account_id, permit_type, granted_by)
         values ($1,'Fencing Permit',$1)`,
        [id],
      );
    }
  }

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
    await db.query(
      `insert into document_number_sequences (series, year, last_issued)
       values ('OP', 2026, 1)
       on conflict (series, year) do update set last_issued = excluded.last_issued`,
    );
  }

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
    // Unused — createApp() below is given the PGlite client directly, the
    // same way dev-server.ts does it. Kept only because the config schema
    // requires SOME value for a backing service it does not actually reach.
    DATABASE_URL: 'postgres://unused@in-process/pglite-persistent',
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
    ...process.env,
  });

  if (config.EBPCO_ENVIRONMENT !== 'development') {
    throw new Error(
      `refusing to start: EBPCO_ENVIRONMENT is "${config.EBPCO_ENVIRONMENT}". `
      + 'This server seeds accounts with a published password and is for development only.',
    );
  }

  const dataDir = process.env.PGLITE_DATA_DIR ?? resolve(__dirname, '../.dev-pgdata');
  const logger = new StructuredLogger('info', (line) => say(line));
  const db = await PgliteClient.create(dataDir);
  await migrate(db, loadMigrations(resolve(__dirname, '../db/migrations')));

  const existing = await db.query<{ id: string }>(
    'select id from accounts where email_normalised = $1', [normaliseEmail('super@lgu.gov.ph')],
  );
  const alreadySeeded = existing.rows.length > 0;

  const credentialsPath = resolve(__dirname, '../.dev-persistent-credentials.json');

  let mfaEnrolled: { email: string; uri: string }[] = [];
  let password = PASSWORD;

  if (!alreadySeeded) {
    const { staffAccountIds } = await seed(db, new PasswordHasher(undefined, config.PASSWORD_PEPPER));

    const totp = new TotpService(
      db,
      new SecretBox(config.TOTP_ENCRYPTION_KEY),
      `eBPCO ${config.EBPCO_ENVIRONMENT}`,
    );
    const secrets: Record<string, string> = {};
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
      secrets[email] = offer.value.secret;
    }

    // Written once, at first seed, so a later Claude/operator session can
    // read the password and TOTP secrets back without needing to decrypt
    // anything or restart (and therefore wipe) the database to find out.
    writeFileSync(credentialsPath, JSON.stringify({
      note: 'Generated once at first seed of the persistent dev database. Not the real deployment '
        + 'bootstrap — see seed-super-admin.ts for that.',
      seededAt: new Date().toISOString(),
      password: PASSWORD,
      totpSecrets: secrets,
    }, null, 2));
  } else {
    password = '(unchanged — see .dev-persistent-credentials.json from when this database was first seeded)';
  }

  const app = await createApp(config, logger, db);
  await app.listen({ port: config.PORT, host: '127.0.0.1' });

  say('');
  say(`  eBPCO API (development, PERSISTENT) — http://127.0.0.1:${config.PORT}`);
  say(`  PGlite data on disk at ${dataDir} — survives a restart.`);
  say('');
  if (alreadySeeded) {
    say('  Database already seeded from a previous run — nothing re-inserted.');
    say(`  Credentials: ${password}`);
  } else {
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
    say(`  All of this was also written to ${credentialsPath}`);
  }
  say('');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
