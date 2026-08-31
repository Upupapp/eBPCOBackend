import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import { IdentityService } from '../src/identity/identity.service';
import { StaffRole } from '../src/identity/roles';

/**
 * Creates one staff account.
 *
 * A deliberate command rather than a seeded default, because a default account
 * with a known password is a fabricated credential by another name — and TAB 11
 * forbids exactly that shortcut, which shipped in a sibling repository and had
 * to be removed.
 *
 * The password is GENERATED and printed once. There is no way to supply a weak
 * one, and no way to read it back afterwards: only its scrypt digest is stored.
 *
 *   DATABASE_URL=... npm run staff:create -- ana@castilla.gov.ph "Ana Cruz" content-approver
 */
const ROLES: readonly StaffRole[] = [
  'viewer', 'content-editor', 'content-approver', 'announcements-publisher', 'administrator',
];

async function main(): Promise<number> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    console.error('DATABASE_URL is not set');
    return 1;
  }

  const [email, displayName, role] = process.argv.slice(2);
  if (email === undefined || displayName === undefined || role === undefined) {
    console.error('usage: staff:create -- <email> <display name> <role>');
    console.error(`roles: ${ROLES.join(', ')}`);
    return 1;
  }
  if (!ROLES.includes(role as StaffRole)) {
    console.error(`unknown role '${role}'. Roles: ${ROLES.join(', ')}`);
    return 1;
  }

  // 24 random bytes. Long enough that the lockout is a backstop rather than
  // the only thing standing between this account and a guess.
  const password = randomBytes(24).toString('base64url');
  const pool = new Pool({ connectionString });
  try {
    await new IdentityService(pool).createAccount(
      email, displayName, role as StaffRole, password);
    console.log(`created ${email} as ${role}`);
    console.log(`password (shown once, not stored): ${password}`);
    return 0;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
