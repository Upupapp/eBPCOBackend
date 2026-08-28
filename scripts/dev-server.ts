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

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { PasswordHasher } from '../src/modules/identity/domain/password-hasher';
import { StaffRole } from '../src/modules/identity/domain/account';

const say = (line = ''): void => void process.stdout.write(`${line}\n`);

/** Published on purpose. See the environment guard above. */
const PASSWORD = 'dev-password-not-for-anywhere-real';

const STAFF: ReadonlyArray<{ email: string; role: StaffRole }> = [
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

async function seed(db: SqlClient, hasher: PasswordHasher): Promise<void> {
  const hash = await hasher.hash(PASSWORD);

  for (const { email, role } of STAFF) {
    const id = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff',$2,$2,$3)`,
      [id, email, hash],
    );
    await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
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
  };
  let sequence = 0;
  for (const [status, steps] of Object.entries(path)) {
    sequence += 1;
    const id = randomUUID();
    await db.query(
      `insert into applications (id, reference_number, applicant_id, business_id, permit_type,
                                 application_action, lifecycle_status, location, submitted_at, created_by)
       values ($1,$2,$3,$4,'Fencing','New','Submitted',$5, now(), $6)`,
      [id, `E-BPCO-2026-${String(sequence).padStart(6, '0')}`, applicant, business,
       `${sequence * 10} Rizal Street, Poblacion`, account],
    );
    for (const step of steps) {
      await db.query('update applications set lifecycle_status = $1 where id = $2', [step, id]);
    }
    void status;
  }

  await db.query(
    `insert into fee_schedules (version, effective_from, published_by)
     values ('2026.1','2026-01-01','City Ordinance 2026-004')`,
  );
  for (const [line, amount] of [['filing', 50_000], ['processing', 120_000], ['structural', 512_000]] as const) {
    await db.query(
      `insert into fee_schedule_entries (version, permit_type, line, amount_centavos, basis)
       values ('2026.1','Fencing',$1,$2,'City Ordinance 2026-004 s.3')`,
      [line, amount],
    );
  }
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
  await seed(db, new PasswordHasher(undefined, config.PASSWORD_PEPPER));

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
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
