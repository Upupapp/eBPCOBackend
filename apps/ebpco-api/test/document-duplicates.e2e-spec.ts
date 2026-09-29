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
import { APPLICANT_SCOPES } from '../src/modules/identity/domain/account';


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
let maria: string;
let jose: string;

const MARIA = randomUUID();
const JOSE = randomUUID();

const token = async (accountId: string): Promise<string> =>
  (await tokens.issueAccessToken({
    sub: accountId, sid: randomUUID(), kind: 'applicant', scopes: [...APPLICANT_SCOPES],
  })).token;

const post = (url: string, bearer: string, payload: Record<string, unknown> = {}, key: string = randomUUID()) =>
  app.inject({
    method: 'POST', url,
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key },
    payload,
  });

const get = (url: string, bearer: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });

const submission = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  permitType: 'Fencing Permit',
  applicationAction: 'New',
  location: '12 Rizal Street, Poblacion Uno',
  ...overrides,
});

beforeEach(async () => {
  db = await PgliteClient.create();
  await migrate(db, loadMigrations(join(__dirname, '../db/migrations')));
  app = await createApp(loadConfig(ENV), new StructuredLogger('error', () => undefined), db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);

  await db.query(
    `insert into accounts (id, kind, email, email_normalised, password_hash)
     values ($1,'applicant','maria@example.ph','maria@example.ph','scrypt$1$1$1$a$b'),
            ($2,'applicant','jose@example.ph','jose@example.ph','scrypt$1$1$1$a$b')`,
    [MARIA, JOSE],
  );
  await db.query(
    `insert into applicants (id, account_id, first_name, last_name)
     values ($1,$2,'Maria','Santos'), ($3,$4,'Jose','Rizal')`,
    [randomUUID(), MARIA, randomUUID(), JOSE],
  );
  maria = await token(MARIA);
  jose = await token(JOSE);
});

afterEach(async () => {
  await app.close();
});

const count = async (sql: string, values: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);


/** A PDF whose bytes differ by `n` — a different file each time. */
const pdf = (n: number): string =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${n}\ntrailer<</Root 1 0 R>>\n%%EOF\n`).toString('base64');

const upload = (bearer: string, extra: Record<string, unknown> = {}) =>
  post('/documents', bearer, { fileName: 'valid-id.pdf', label: 'Valid ID', contentBase64: pdf(1), ...extra });

interface LibraryEntry {
  id: string; fileName: string; applicationId: string | null;
  applications: { id: string; referenceNumber: string }[]; copies: number;
}

/**
 * The same file, uploaded again (owner request, 2026-09-29): refused with the
 * copy the citizen already has, so they reuse it; and My Documents shows each
 * file once however many applications carry a copy.
 */
describe('uploading a file the citizen already has', () => {
  it('refuses it with the copy they already have', async () => {
    const first = await upload(maria);
    expect(first.statusCode).toBe(201);
    const { documentId } = first.json<{ documentId: string }>();

    const again = await upload(maria, { fileName: 'renamed-copy.pdf', label: 'Barangay Clearance' });
    expect(again.statusCode).toBe(409);
    const problem = again.json<{ reason: string; detail: string; existingDocument: { id: string; fileName: string } }>();
    expect(problem.reason).toBe('duplicate-document');
    expect(problem.existingDocument).toMatchObject({ id: documentId, fileName: 'valid-id.pdf' });
    expect(problem.detail).toMatch(/Reuse it from My Documents/);
    expect(await count('select count(*) as n from documents')).toBe(1);
  });

  it('takes a different file with the same name', async () => {
    expect((await upload(maria)).statusCode).toBe(201);
    expect((await upload(maria, { contentBase64: pdf(2) })).statusCode).toBe(201);
  });

  it('is per citizen: someone else may upload the same file', async () => {
    expect((await upload(maria)).statusCode).toBe(201);
    expect((await upload(jose)).statusCode).toBe(201);
  });

  it('lets a declared reuse through, and only of their own copy of those bytes', async () => {
    const { documentId } = (await upload(maria)).json<{ documentId: string }>();

    expect((await upload(maria, { reuseOf: documentId })).statusCode).toBe(201);
    // Jose cannot launder Maria's id into a reuse of his own duplicate.
    expect((await upload(jose)).statusCode).toBe(201);
    expect((await upload(jose, { reuseOf: documentId })).statusCode).toBe(409);
  });

  it('takes the file again once it has been deleted from My Documents', async () => {
    const { documentId } = (await upload(maria)).json<{ documentId: string }>();
    const removed = await app.inject({
      method: 'DELETE', url: `/documents/${documentId}`, headers: { authorization: `Bearer ${maria}` },
    });
    expect(removed.statusCode).toBe(204);

    expect((await upload(maria)).statusCode).toBe(201);
  });
});

describe('My Documents shows each file once', () => {
  const library = async (): Promise<LibraryEntry[]> => (await get('/documents/me', maria)).json<LibraryEntry[]>();

  it('groups the copies of a file on different applications into one entry', async () => {
    const original = (await upload(maria)).json<{ documentId: string }>().documentId;
    const first = await post('/applications', maria, submission({ documentIds: [original] }));
    expect(first.statusCode).toBe(201);
    const reused = (await upload(maria, { reuseOf: original })).json<{ documentId: string }>().documentId;
    const second = await post('/applications', maria, submission({ documentIds: [reused] }));
    expect(second.statusCode).toBe(201);
    await upload(maria, { fileName: 'other.pdf', label: 'Other', contentBase64: pdf(3) });

    const entries = await library();
    expect(entries.map((e) => e.fileName).sort()).toEqual(['other.pdf', 'valid-id.pdf']);
    const id = entries.find((e) => e.fileName === 'valid-id.pdf')!;
    expect(id.copies).toBe(2);
    expect(id.applications.map((a) => a.referenceNumber).sort()).toEqual(
      [first.json<{ referenceNumber: string }>().referenceNumber, second.json<{ referenceNumber: string }>().referenceNumber].sort(),
    );
  });

  it('shows the unattached copy, the one that can be attached as it is', async () => {
    const original = (await upload(maria)).json<{ documentId: string }>().documentId;
    const spare = (await upload(maria, { reuseOf: original })).json<{ documentId: string }>().documentId;
    expect((await post('/applications', maria, submission({ documentIds: [original] }))).statusCode).toBe(201);

    const [entry] = await library();
    expect(entry).toMatchObject({ id: spare, applicationId: null, copies: 2 });
  });

  it('deletes the file, every copy of it, from My Documents; copies on applications stay filed', async () => {
    const original = (await upload(maria)).json<{ documentId: string }>().documentId;
    const filed = await post('/applications', maria, submission({ documentIds: [original] }));
    const spare = (await upload(maria, { reuseOf: original })).json<{ documentId: string }>().documentId;

    const removed = await app.inject({
      method: 'DELETE', url: `/documents/${spare}`, headers: { authorization: `Bearer ${maria}` },
    });
    expect(removed.statusCode).toBe(204);

    expect(await library()).toEqual([]);
    const onApplication = await get(`/applications/${filed.json<{ id: string }>().id}/documents`, maria);
    expect(onApplication.json<{ id: string }[]>().map((d) => d.id)).toEqual([original]);
  });
});
