import { randomUUID } from 'node:crypto';

import { loadConfig } from '../src/config/app-config';
import { PostgresClient } from '../src/persistence/postgres-client';
import { PasswordHasher } from '../src/modules/identity/domain/password-hasher';
import { MFA_REQUIRED_ROLES } from '../src/modules/identity/domain/account';
import { SecretBox } from '../src/modules/identity/domain/secret-box';
import { TotpService } from '../src/modules/identity/application/totp.service';
import { codeFor, stepAt } from '../src/modules/identity/domain/totp';

/**
 * Creates the first super admin.
 *
 * ── Why this exists at all ──────────────────────────────────────────────
 *
 * There is no path through the API to the first staff account, and that is by
 * design rather than an oversight. `POST /staff/users` and
 * `/staff/access-requests/:id/approve` both require `staff:administer`; only
 * `administrator` and `super-admin` hold it; and every public route mints an
 * applicant or a row somebody else must act on. A service that could bootstrap
 * its own administrator over HTTP would be a service anyone could bootstrap an
 * administrator on.
 *
 * So the first account is made out of band, once, by someone with database
 * credentials. Everything after it goes through the request-and-approve flow.
 *
 * ── The password ────────────────────────────────────────────────────────
 *
 * Read from EBPCO_SUPERADMIN_PASSWORD and nowhere else. It is never written to
 * a file, a fixture, a migration or a log line, and this script FAILS rather
 * than inventing a default — a seeded default password is a known credential on
 * every deployment that ever ran the script, and the fact that it was meant to
 * be changed is not a control.
 *
 *   EBPCO_SUPERADMIN_PASSWORD='...' DATABASE_URL='...' npm run seed:super-admin
 *
 * ── What it grants, and why that is not obvious ─────────────────────────
 *
 * The role alone is not enough. The forms allow-list fails CLOSED, so a super
 * admin with no assignment can sign in, reach no application, and see a
 * dashboard reading zero — which looks exactly like a broken deployment. The
 * account therefore gets an explicit assignment, the same one migration 032's
 * backfill gives every officer that predates the allow-list.
 *
 * ── Why it also enrols the second factor ────────────────────────────────
 *
 * `super-admin` is in MFA_REQUIRED_ROLES, and sign-in demands a TOTP code
 * UNCONDITIONALLY for such a role — `verifyTotp` returns false when no secret
 * is enrolled. Enrolling one needs a session, and a session needs the code. An
 * MFA-required account created without a second factor can therefore never sign
 * in, and no reset recovers it: password reset returns 204 and issues no
 * session.
 *
 * So the seed completes the enrolment itself. It generates the secret through
 * the same service the product uses, computes the current code from it, and
 * activates — then prints the otpauth URI ONCE for an authenticator app. The
 * secret is never stored in plaintext: the service seals it exactly as it would
 * for an officer enrolling through /me/mfa.
 *
 * This is not specific to the seed. Any account given an MFA-required role
 * before it has enrolled is locked out the same way — see
 * docs/FINDINGS-2026-08-31-first-real-client-call.md, D-10.
 *
 * ── Rerunning it ────────────────────────────────────────────────────────
 *
 * Idempotent by address. A second run against an existing account changes
 * nothing and says so, rather than resetting a password somebody has since
 * rotated.
 */
const EMAIL = 'paul@lguids.com.ph';
const ROLE = 'super-admin';

async function main(): Promise<number> {
  const password = process.env['EBPCO_SUPERADMIN_PASSWORD'];
  if (password === undefined || password.trim() === '') {
    process.stderr.write(
      'EBPCO_SUPERADMIN_PASSWORD is not set.\n'
      + 'This script will not invent one: a default password is a known credential '
      + 'on every deployment that ever ran it.\n');
    return 1;
  }
  if (password.length < 12) {
    // The policy the service applies to everyone else. An administrator
    // exempting themselves from it is the account most worth attacking.
    process.stderr.write('EBPCO_SUPERADMIN_PASSWORD must be at least 12 characters.' + '\n');
    return 1;
  }

  const config = loadConfig(process.env);
  // One connection: this writes a handful of rows once, and a pool would open
  // several against a database the operator may have opened a tunnel to.
  const db = PostgresClient.fromUrl(config.DATABASE_URL, {
    max: 1,
    connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  });

  try {
    const existing = await db.query<{ id: string }>(
      'select id from accounts where email_normalised = $1', [EMAIL]);
    if (existing.rows.length > 0) {
      process.stdout.write(`${EMAIL} already exists (${existing.rows[0]!.id}).` + '\n');
      process.stdout.write('Nothing changed. Rotate the password through the account-recovery flow.' + '\n');
      return 0;
    }

    const id = randomUUID();
    // Default cost, real pepper. The pepper is why a stolen database alone
    // does not yield this verifier.
    const hasher = new PasswordHasher(undefined, config.PASSWORD_PEPPER);

    await db.transaction(async (tx) => {
      await tx.query(
        `insert into accounts (id, kind, email, email_normalised, password_hash, created_at)
         values ($1,'staff',$2,$2,$3, now())`,
        [id, EMAIL, await hasher.hash(password)]);
      await tx.query(
        'insert into account_roles (account_id, role) values ($1,$2)', [id, ROLE]);

      // The assignment, in the same transaction. An account created without one
      // is an account that signs in and reaches nothing.
      await tx.query(
        'insert into staff_access (account_id, level, assigned_by) values ($1,$2,$1)',
        [id, 'view-edit']);
      await tx.query(
        `insert into staff_permit_access (account_id, permit_type, granted_by)
         select $1, permit_type, $1 from permit_types where retired_at is null`, [id]);

      // On the security stream, like every other access event. The actor is the
      // seed itself: nobody was signed in, and naming a person would put a
      // falsehood in an append-only chain.
      await tx.query(
        `insert into audit_events (actor_account_id, actor_role, action, subject_type,
                                   subject_id, outcome, after_state, entry_hash)
         values (null, 'seed', 'access.approved', 'account', $1, 'allowed', $2, 'seed')`,
        [id, JSON.stringify({ role: ROLE, level: 'view-edit', seeded: true })]);
    });

    // The second factor, completed here because nothing else can complete it.
    const totp = new TotpService(
      db,
      new SecretBox(config.TOTP_ENCRYPTION_KEY || 'development-only-totp-key'),
      `eBPCO ${config.EBPCO_ENVIRONMENT === 'production' ? '' : config.EBPCO_ENVIRONMENT}`.trim(),
    );
    const offer = await totp.begin({ accountId: id });
    if (!offer.ok) {
      process.stderr.write(`could not begin MFA enrolment: ${offer.detail}` + '\n');
      return 1;
    }
    const activated = await totp.activate({
      accountId: id,
      // Computed from the secret just issued. The alternative is an account
      // that cannot sign in and cannot enrol.
      code: codeFor(offer.value.secret, stepAt(new Date())),
    });
    if (!activated.ok) {
      process.stderr.write(`could not activate MFA: ${activated.detail}` + '\n');
      return 1;
    }

    const granted = await db.query<{ n: number }>(
      'select count(*)::int as n from staff_permit_access where account_id = $1', [id]);

    process.stdout.write(`created ${EMAIL} as ${ROLE} (${id})` + '\n');
    process.stdout.write(`  level: view-edit, permit types: ${String(granted.rows[0]!.n)}` + '\n');
    if (MFA_REQUIRED_ROLES.includes(ROLE)) {
      process.stdout.write('\n');
      process.stdout.write('  MFA is enrolled and ACTIVE. Add this to an authenticator app now —' + '\n');
      process.stdout.write('  it is shown once and cannot be retrieved:' + '\n');
      process.stdout.write('\n');
      process.stdout.write(`    ${offer.value.uri}` + '\n');
      process.stdout.write('\n');
      process.stdout.write('  Without it, nobody can sign in to this account.' + '\n');
    }
    process.stdout.write('  Rotate the password after first sign-in.' + '\n');
    return 0;
  } finally {
    await db.close();
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
