import { join } from 'node:path';

import { PgliteClient } from '../../../persistence/pglite-client';
import { SqlClient } from '../../../persistence/sql-client';
import { loadMigrations, migrate } from '../../../persistence/migrator';
import { RegistrationVerificationService } from './registration-verification.service';

/**
 * The emailed code a citizen confirms before registering.
 *
 * The regression these exist for: every path that RETIRES a code the citizen
 * never confirmed — asking for a new one (Resend Code), typing an expired
 * one, and the last allowed wrong guess — marked it `consumed_at`, which
 * migration 048's `registration_challenge_consumed_implies_confirmed`
 * refuses. All three were a 500 in the registration wizard.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../db/migrations');
const EMAIL = 'juan.dcruz@example.ph';

let db: SqlClient;
let now: Date;
let service: RegistrationVerificationService;

const minutes = (n: number): void => { now = new Date(now.getTime() + n * 60_000); };

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  now = new Date('2026-09-27T07:30:00Z');
  service = new RegistrationVerificationService(db, () => now, 'pepper');
});

afterEach(async () => {
  await db.close();
});

async function codeFor(email = EMAIL): Promise<string> {
  const result = await service.request(email);
  if (!result.ok) throw new Error(result.detail);
  return result.code;
}

const rows = async (): Promise<number> =>
  Number((await db.query<{ n: string }>(
    'select count(*) as n from registration_email_challenges where email = $1', [EMAIL],
  )).rows[0]?.n ?? 0);

describe('asking for a code', () => {
  it('confirms the code that was sent', async () => {
    const code = await codeFor();

    expect(await service.confirm(EMAIL, code)).toEqual({ ok: true });
  });

  it('refuses a second request inside the resend window', async () => {
    await codeFor();
    minutes(0.5);

    const again = await service.request(EMAIL);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('too-soon');
  });

  it('sends a new code on Resend once the window has passed, and only the new one works', async () => {
    const first = await codeFor();
    minutes(2);

    const second = await codeFor();

    expect(await rows()).toBe(1);
    const stale = await service.confirm(EMAIL, first);
    if (first !== second) expect(stale).toMatchObject({ ok: false, reason: 'wrong-code' });
    expect(await service.confirm(EMAIL, second)).toEqual({ ok: true });
  });

  it('can resend more than once', async () => {
    await codeFor();
    minutes(2);
    await codeFor();
    minutes(2);
    const third = await codeFor();

    expect(await service.confirm(EMAIL, third)).toEqual({ ok: true });
  });

  it('matches the email however it was capitalised', async () => {
    const code = await codeFor('Juan.DCruz@Example.PH ');

    expect(await service.confirm(EMAIL, code)).toEqual({ ok: true });
  });
});

describe('a code that can no longer be used', () => {
  it('says an expired code has expired, and lets the citizen ask for another', async () => {
    const code = await codeFor();
    minutes(16);

    expect(await service.confirm(EMAIL, code)).toMatchObject({ ok: false, reason: 'expired' });
    expect(await rows()).toBe(0);
    const fresh = await codeFor();
    expect(await service.confirm(EMAIL, fresh)).toEqual({ ok: true });
  });

  it('retires the code after five wrong guesses, and a new one can be requested', async () => {
    const code = await codeFor();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 4; i += 1) {
      expect(await service.confirm(EMAIL, wrong)).toMatchObject({ ok: false, reason: 'wrong-code' });
    }
    expect(await service.confirm(EMAIL, wrong)).toMatchObject({ ok: false, reason: 'too-many-attempts' });
    // Even the right code no longer works — the challenge is gone.
    expect(await service.confirm(EMAIL, code)).toMatchObject({ ok: false, reason: 'no-challenge' });

    const fresh = await codeFor();
    expect(await service.confirm(EMAIL, fresh)).toEqual({ ok: true });
  });
});

describe('the proof registration spends', () => {
  it('is spent exactly once, by the registration it verifies', async () => {
    const code = await codeFor();
    await service.confirm(EMAIL, code);

    expect(await service.consumeConfirmedProof(EMAIL)).toBe(true);
    expect(await service.consumeConfirmedProof(EMAIL)).toBe(false);
  });

  it('is not there for a code that was only requested, never confirmed', async () => {
    await codeFor();

    expect(await service.consumeConfirmedProof(EMAIL)).toBe(false);
  });

  it('lets a citizen who confirmed, then closed the app, verify again', async () => {
    const code = await codeFor();
    await service.confirm(EMAIL, code);
    minutes(2);

    const again = await codeFor();

    expect(await service.confirm(EMAIL, again)).toEqual({ ok: true });
    expect(await service.consumeConfirmedProof(EMAIL)).toBe(true);
  });
});
