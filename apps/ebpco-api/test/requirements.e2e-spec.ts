import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/bootstrap';
import { PgliteClient } from '../src/persistence/pglite-client';
import { SqlClient } from '../src/persistence/sql-client';
import { loadMigrations, migrate } from '../src/persistence/migrator';
import { loadConfig } from '../src/config/app-config';
import { StructuredLogger } from '../src/common/logging/logger';
import { TokenService } from '../src/modules/identity/application/token.service';
import { APPLICANT_SCOPES, StaffRole, scopesFor } from '../src/modules/identity/domain/account';

/**
 * TAB 09 — the checklist a permit type asks for.
 *
 * The rule that matters: THE CHECKLIST CHANGES, A FILED APPLICATION DOES NOT.
 * Someone who submitted everything asked of them in March cannot become
 * non-compliant in April because the LGU added a document.
 */

jest.setTimeout(30_000);

const ENV: NodeJS.ProcessEnv = {
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
  TOTP_ENCRYPTION_KEY: 'a-test-totp-key-of-at-least-32-characters',
  PUSH_TOKEN_ENCRYPTION_KEY: 'a-test-push-key-of-at-least-32-characters',
  RATE_LIMIT_MAX: '10000',
};

let app: NestFastifyApplication;
let db: SqlClient;
let tokens: TokenService;
let admin: string;
let officer: string;
let applicant: string;
let applicantAccount: string;
const logLines: string[] = [];

async function staffToken(role: StaffRole): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'staff',$2,$2,'scrypt$1$1$1$a$b')`,
    [id, `${role}-${id.slice(0, 8)}@lgu.gov.ph`],
  );
  await db.query('insert into account_roles (account_id, role) values ($1,$2)', [id, role]);
  return (await tokens.issueAccessToken({
    sub: id, sid: randomUUID(), kind: 'staff',
    scopes: [...scopesFor({ kind: 'staff', roles: [role] })],
  })).token;
}

const send = (
  method: 'GET' | 'PUT' | 'POST', url: string, bearer: string, payload?: Record<string, unknown>,
) => app.inject({
  method, url,
  headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': randomUUID() },
  ...(payload === undefined ? {} : { payload }),
});

const CHECKLIST = {
  documents: [
    { code: 'lot-plan', label: 'Lot Plan', description: 'Signed by a geodetic engineer.', required: true },
    { code: 'tax-clearance', label: 'Tax Clearance', description: '', required: true },
    { code: 'photos', label: 'Site Photographs', description: '', required: false },
  ],
};

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', (l) => logLines.push(l)), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
  admin = await staffToken('administrator');
  officer = await staffToken('records-officer');

  applicantAccount = randomUUID();
  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b')`,
    [applicantAccount],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name) values ($1,$2,'Maria','Santos')`,
    [randomUUID(), applicantAccount],
  );
  applicant = (await tokens.issueAccessToken({
    sub: applicantAccount, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
  })).token;
});

afterEach(async () => {
  const failures = logLines.filter((line) => line.includes('"status":500'));
  logLines.length = 0;
  await app.close();
  await db.close();
  if (failures.length > 0) throw new Error(failures.join('\n').replace(/\\n\s+at [^"]*/g, '').slice(0, 800));
});

describe('publishing a checklist', () => {
  it('saves it and reads it back in the order the LGU set', async () => {
    // Not alphabetical, and not insertion order once anything has been edited.
    const response = await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ documents: { code: string }[] }>().documents.map((d) => d.code))
      .toEqual(['lot-plan', 'tax-clearance', 'photos']);
  });

  it('replaces wholesale, so a document left out is a document dropped', async () => {
    // A diff API would let a client drop a requirement by forgetting to mention
    // it. Replacing makes the omission deliberate.
    await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);

    await send('PUT', '/staff/config/requirements/Fencing', admin, {
      documents: [CHECKLIST.documents[0]],
    });

    const listed = await send('GET', '/staff/config/requirements/Fencing', officer);
    expect(listed.json<{ documents: unknown[] }>().documents).toHaveLength(1);
  });

  it('keeps an optional document on the list rather than hiding it', async () => {
    // An applicant not told about an optional document cannot choose to bring it.
    await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);

    const listed = await send('GET', '/requirements/Fencing', applicant);
    const photos = listed.json<{ documents: { code: string; required: boolean }[] }>()
      .documents.find((d) => d.code === 'photos');
    expect(photos).toMatchObject({ required: false });
  });

  it('refuses two documents sharing a code', async () => {
    // A code is what survives a rename. Two documents sharing one is a
    // checklist that cannot be edited afterwards.
    const response = await send('PUT', '/staff/config/requirements/Fencing', admin, {
      documents: [
        { code: 'lot-plan', label: 'Lot Plan', description: '', required: true },
        { code: 'lot-plan', label: 'Lot Plan (signed)', description: '', required: true },
      ],
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toMatch(/share the code/i);
  });

  it('refuses a permit type the LGU does not issue', async () => {
    expect((await send('PUT', '/staff/config/requirements/Interdimensional Portal', admin, CHECKLIST))
      .statusCode).toBe(404);
  });

  it('REFUSES an officer who handles applications but does not set the rules', async () => {
    // Deciding what every future applicant must bring is a different job from
    // handling one application.
    expect((await send('PUT', '/staff/config/requirements/Fencing', officer, CHECKLIST))
      .statusCode).toBe(403);
  });

  it('lets an APPLICANT read it, because a checklist they cannot see is one they discover at a counter', async () => {
    await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);

    const response = await send('GET', '/requirements/Fencing', applicant);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ documents: unknown[] }>().documents).toHaveLength(3);
  });

  it('still refuses an applicant the staff config path', async () => {
    expect((await send('GET', '/staff/config/requirements/Fencing', applicant)).statusCode).toBe(403);
  });
});

describe('what a filed application was judged against', () => {
  const file = async (): Promise<string> => {
    const response = await send('POST', '/applications', applicant, {
      permitType: 'Fencing', applicationAction: 'New', location: '12 Rizal Street',
      businessId: null, documentIds: [], form: {},
    });
    expect(response.statusCode).toBe(201);
    // `id`, not `applicationId` — the applicant-facing filing response returns
    // the whole application as the client will render it, not a receipt.
    return response.json<{ id: string }>().id;
  };

  it('captures the checklist at filing', async () => {
    await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);

    const applicationId = await file();

    const row = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [applicationId],
    );
    expect(row.rows[0]?.required_documents.map((d) => d.code))
      .toEqual(['lot-plan', 'tax-clearance', 'photos']);
  });

  it('DOES NOT REWRITE IT when the LGU changes the checklist afterwards', async () => {
    // The rule the whole design exists for. An applicant who submitted
    // everything asked of them cannot become non-compliant retroactively.
    await send('PUT', '/staff/config/requirements/Fencing', admin, CHECKLIST);
    const applicationId = await file();

    await send('PUT', '/staff/config/requirements/Fencing', admin, {
      documents: [
        ...CHECKLIST.documents,
        { code: 'barangay-clearance', label: 'Barangay Clearance', description: '', required: true },
      ],
    });

    const row = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [applicationId],
    );
    expect(row.rows[0]?.required_documents.map((d) => d.code)).not.toContain('barangay-clearance');
    // And a NEW application does pick it up.
    const later = await file();
    const newer = await db.query<{ required_documents: { code: string }[] }>(
      'select required_documents from applications where id = $1', [later],
    );
    expect(newer.rows[0]?.required_documents.map((d) => d.code)).toContain('barangay-clearance');
  });

  it('records an empty list when nothing has been published, rather than null', async () => {
    // A filed application always says what it was judged against, even when the
    // answer is "nothing was required yet" — which is a fact an officer needs.
    const applicationId = await file();

    const row = await db.query<{ required_documents: unknown[] }>(
      'select required_documents from applications where id = $1', [applicationId],
    );
    expect(row.rows[0]?.required_documents).toEqual([]);
  });
});
