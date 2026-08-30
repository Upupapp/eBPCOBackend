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
import { APPLICANT_SCOPES, scopesFor } from '../src/modules/identity/domain/account';

/**
 * An applicant filing, uploading, paying and withdrawing — over HTTP.
 *
 * Until this TAB the mobile app could read everything and file nothing. What is
 * asserted here is the write half: that a replay files once, that an applicant
 * cannot write against someone else's record, and that the refusals say
 * something the applicant can act on.
 */

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

/** A minimal, valid PDF the malware scanner and inspector will accept. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const submission = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  permitType: 'Fencing',
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

describe('filing an application', () => {
  it('returns the whole application, in the shape a GET would give', async () => {
    // So a client does not have to build a half-record from a creation
    // response and then reconcile it with the next fetch.
    const response = await post('/applications', maria, submission());

    expect(response.statusCode).toBe(201);
    const body = response.json<{ referenceNumber: string; applicantStatus: string; payment: unknown }>();
    expect(body.referenceNumber).toMatch(/^E-BPCO-2026-\d{6}$/);
    expect(body.applicantStatus).toBe('Submitted');
    expect(body.payment).toEqual({ status: 'Not Yet Available' });
  });

  it('stores what the applicant typed, which it used to discard', async () => {
    // `form` reached the controller, was parsed, and was dropped. An officer
    // opening the application saw a permit type, a location and a stack of
    // documents, and none of the fifteen screens the applicant had filled in.
    const answers = { lotArea: 240, storeys: 2, engineer: 'Ana Dela Cruz, PRC 0012345' };

    const filed = await post('/applications', maria, submission({ form: answers }));

    expect(filed.statusCode).toBe(201);
    const row = await db.query<{ form: Record<string, unknown> }>(
      'select form from applications where id = $1', [filed.json<{ id: string }>().id],
    );
    expect(row.rows[0]!.form).toEqual(answers);
  });

  it('refuses a form larger than the limit, pointing at the form', async () => {
    // An endpoint accepting arbitrary JSON with no bounds accepts a
    // ten-megabyte nested object.
    const response = await post('/applications', maria, submission({
      form: { notes: 'x'.repeat(300_000) },
    }));

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].pointer).toBe('/form');
  });

  it('points at the field an applicant has to go back to', async () => {
    // "Some answers are not valid" sends someone back through fifteen screens.
    const response = await post('/applications', maria, submission({
      form: { scope: { fencing: { material: 'x'.repeat(9_000) } } },
    }));

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].pointer).toBe('/form/scope/fencing/material');
  });

  it('refuses a filing with no Idempotency-Key', async () => {
    // The mobile client queues these offline and replays them, so a replay is
    // the normal case rather than an edge one.
    const response = await app.inject({
      method: 'POST', url: '/applications',
      headers: { authorization: `Bearer ${maria}` },
      payload: submission(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a key that is not a UUID', async () => {
    // A client sending "1" every time would file once and silently replay for
    // ever.
    const response = await post('/applications', maria, submission(), 'my-key');

    expect(response.statusCode).toBe(400);
  });

  it('files exactly once however many times the queue replays it', async () => {
    const key = randomUUID();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await post('/applications', maria, submission(), key);
    }

    expect(await count('select count(*) as n from applications')).toBe(1);
  });

  it('refuses a staff token', async () => {
    const officer = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','o@lgu.gov.ph','o@lgu.gov.ph','scrypt$1$1$1$a$b')`, [officer],
    );
    const staff = (await tokens.issueAccessToken({
      sub: officer, sid: randomUUID(), kind: 'staff', scopes: [...scopesFor({ kind: 'staff', roles: ['records-officer'] })],
    })).token;

    expect((await post('/applications', staff, submission())).statusCode).toBe(403);
  });

  it('says which permit type it does not issue', async () => {
    const response = await post('/applications', maria, submission({ permitType: 'Time Machine' }));

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain('Time Machine');
  });
});

describe('uploading a document', () => {
  it('accepts a file and reports what metadata was stripped', async () => {
    // A photograph of a plan carries GPS coordinates of the site and the device
    // that took it. An applicant is entitled to know the LGU removed them —
    // both because it is their data and because it explains why the file is not
    // byte-identical.
    const response = await post('/documents', maria, {
      fileName: 'lot-plan.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('removedMetadata');
  });

  it('refuses something that is not base64', async () => {
    const response = await post('/documents', maria, {
      fileName: 'x.pdf', label: 'Lot plan', contentBase64: '!!!not base64!!!',
    });

    expect(response.statusCode).toBe(400);
  });

  it('attaches an uploaded document to a filing', async () => {
    const upload = await post('/documents', maria, {
      fileName: 'lot-plan.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    const documentId = upload.json<{ documentId: string }>().documentId;

    const filed = await post('/applications', maria, submission({ documentIds: [documentId] }));

    expect(filed.statusCode).toBe(201);
    const applicationId = filed.json<{ id: string }>().id;
    expect(await count(
      'select count(*) as n from documents where application_id = $1', [applicationId],
    )).toBe(1);
  });

  it('refuses to attach someone else’s document', async () => {
    const upload = await post('/documents', jose, {
      fileName: 'jose.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    const documentId = upload.json<{ documentId: string }>().documentId;

    const filed = await post('/applications', maria, submission({ documentIds: [documentId] }));

    expect(filed.statusCode).toBe(422);
    expect(filed.json().detail).toMatch(/not yours/i);
  });

  it('will not hand out a link to someone else’s document', async () => {
    const upload = await post('/documents', jose, {
      fileName: 'jose.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    const documentId = upload.json<{ documentId: string }>().documentId;

    expect((await get(`/documents/${documentId}/content`, maria)).statusCode).toBe(404);
  });
});

describe('downloading a document', () => {
  async function uploaded(): Promise<{ documentId: string; url: string }> {
    const upload = await post('/documents', maria, {
      fileName: 'lot-plan.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    // Checked here, not left to surface three lines later. An upload that fails
    // leaves `documentId` undefined and the failure then arrives as a 404 on
    // `/documents/undefined/content`, which names the wrong step: it reads as a
    // broken download route rather than an upload that never happened.
    if (upload.statusCode !== 201) {
      throw new Error(`upload failed: ${upload.statusCode} ${upload.body}`);
    }
    const documentId = upload.json<{ documentId: string }>().documentId;
    const link = await get(`/documents/${documentId}/content`, maria);
    if (link.statusCode !== 200) {
      throw new Error(`could not mint a link: ${link.statusCode} ${JSON.stringify(link.json())}`);
    }
    return { documentId, url: link.json<{ url: string }>().url };
  }

  it('actually serves the bytes, which the signed link never did', async () => {
    // `signedUrl` has always pointed at `/documents/content` and nothing served
    // it, so every link handed to an applicant answered 404 — no document could
    // be downloaded, and the integrity check behind it had never run outside a
    // test.
    const { url } = await uploaded();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(PDF)).toBe(true);
  });

  it('needs no bearer token, because the signature IS the authorisation', async () => {
    // That is what a signed URL is for: a download fetched by a browser, an
    // image tag or a download manager, none of which carry one.
    const { url } = await uploaded();

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('always serves as an attachment, never inline', async () => {
    // These are files an applicant uploaded, served from the API's own origin.
    // An HTML or SVG document rendered inline here is stored cross-site
    // scripting against every officer who opens it.
    const { url } = await uploaded();

    const response = await app.inject({ method: 'GET', url });

    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not let a filename rewrite the response headers', async () => {
    // Applicants name their own files. A name containing a quote or a newline
    // would let the rest of the header be rewritten.
    const upload = await post('/documents', maria, {
      fileName: 'plan".pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    const documentId = upload.json<{ documentId: string }>().documentId;
    const url = (await get(`/documents/${documentId}/content`, maria)).json<{ url: string }>().url;

    const disposition = (await app.inject({ method: 'GET', url })).headers['content-disposition'];

    expect(disposition).toBe('attachment; filename="plan_.pdf"');
  });

  it('refuses a forged signature', async () => {
    const { url } = await uploaded();
    const forged = url.replace(/sig=[^&]*/, 'sig=forged');

    expect((await app.inject({ method: 'GET', url: forged })).statusCode).toBe(404);
  });

  it('refuses a link whose key was swapped for another document', async () => {
    // The signature covers the key, so pointing a valid signature at a
    // different object does not verify.
    const mine = await uploaded();
    const theirs = await post('/documents', jose, {
      fileName: 'jose.pdf', label: 'Lot plan', contentBase64: PDF.toString('base64'),
    });
    const theirId = theirs.json<{ documentId: string }>().documentId;
    const theirKey = (await db.query<{ storage_key: string }>(
      'select storage_key from documents where id = $1', [theirId],
    )).rows[0]!.storage_key;

    const swapped = mine.url.replace(/key=[^&]*/, `key=${encodeURIComponent(theirKey)}`);

    expect((await app.inject({ method: 'GET', url: swapped })).statusCode).toBe(404);
  });

  it('refuses an expired link, and says to open the document again', async () => {
    const { url } = await uploaded();
    const expired = url.replace(/expires=\d+/, `expires=${Math.floor(Date.now() / 1000) - 10}`);

    // Re-signing is impossible without the key, so the signature no longer
    // matches either — both checks refuse it, which is the intended belt and
    // braces.
    expect((await app.inject({ method: 'GET', url: expired })).statusCode).toBe(404);
  });

  it('refuses once the document is quarantined, even inside the link’s window', async () => {
    // A document can be rejected by a rescan in the seconds after a link was
    // issued, and a link that keeps working after that is the one case where
    // these two minutes matter.
    const { documentId, url } = await uploaded();
    await db.query(`update documents set status = 'Rejected' where id = $1`, [documentId]);

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('refuses when the stored bytes no longer match their checksum', async () => {
    // Serving them would hand an applicant a document the LGU can no longer
    // vouch for.
    const { documentId, url } = await uploaded();
    await db.query(
      `update documents set sha256 = $2 where id = $1`, [documentId, 'f'.repeat(64)],
    );

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(500);
  });
});

describe('paying', () => {
  async function filed(): Promise<string> {
    return (await post('/applications', maria, submission())).json<{ id: string }>().id;
  }

  it('refuses before an Order of Payment exists, and says so specifically', async () => {
    // Not 404 and not 400. The application exists and the request is well
    // formed; what is missing is the assessment, and telling the applicant that
    // is the difference between them waiting and them calling the LGU.
    const applicationId = await filed();

    const response = await post(`/applications/${applicationId}/payments`, maria, {
      referenceNumber: 'BT-9931882', method: 'Bank Transfer',
      paidOn: '2026-08-20', amountCentavos: 682_000,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/order of payment/i);
  });

  it('refuses to pay against someone else’s application', async () => {
    const applicationId = await filed();

    const response = await post(`/applications/${applicationId}/payments`, jose, {
      referenceNumber: 'BT-1', method: 'Bank Transfer',
      paidOn: '2026-08-20', amountCentavos: 682_000,
    });

    expect(response.statusCode).toBe(404);
  });

  it('records proof once, however many times it is replayed', async () => {
    const applicationId = await filed();
    const orderId = randomUUID();
    await db.query(
      `insert into orders_of_payment (id, application_id, number, filing_centavos, processing_centavos,
                                      architectural_centavos, structural_centavos, electrical_centavos,
                                      others_centavos, total_centavos, fee_schedule_version, assessed_by)
       values ($1,$2,'OP-1',50000,120000,0,512000,0,0,682000,'2026.1',$3)`,
      [orderId, applicationId, MARIA],
    );
    const key = randomUUID();
    const proof = {
      referenceNumber: 'BT-9931882', method: 'Bank Transfer',
      paidOn: '2026-08-20', amountCentavos: 682_000,
    };

    await post(`/applications/${applicationId}/payments`, maria, proof, key);
    await post(`/applications/${applicationId}/payments`, maria, proof, key);

    expect(await count('select count(*) as n from payments')).toBe(1);
  });
});

describe('withdrawing', () => {
  it('is allowed before fees are assessed', async () => {
    const applicationId = (await post('/applications', maria, submission())).json<{ id: string }>().id;

    const response = await post(`/applications/${applicationId}/cancel`, maria, { reason: 'Filed in error' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('Cancelled');
  });

  it('is refused once fees have been assessed, and says where to go', async () => {
    // Decision E-4: past an Order of Payment, cancelling touches money the
    // applicant may already have transferred, and unwinding it is a treasury
    // operation rather than a button.
    const applicationId = (await post('/applications', maria, submission())).json<{ id: string }>().id;
    for (const status of ['Received', 'Document Verification', 'Under Evaluation', 'Assessed']) {
      await db.query('update applications set lifecycle_status = $1 where id = $2', [status, applicationId]);
    }

    const response = await post(`/applications/${applicationId}/cancel`, maria, {});

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/treasury/i);
  });

  it('is refused for someone else’s application', async () => {
    const applicationId = (await post('/applications', maria, submission())).json<{ id: string }>().id;

    expect((await post(`/applications/${applicationId}/cancel`, jose, {})).statusCode).toBe(404);
  });
});

describe('registering a business', () => {
  const business = {
    name: 'Aling Nena Sari-Sari Store', category: 'Retail', street: '12 Rizal Street',
    barangay: 'Poblacion Uno', city: 'Cabuyao', province: 'Laguna',
    registrationNumber: 'DTI-2024-004417', dateRegistered: '2024-01-15',
  };

  it('registers it to the caller, whatever the body says', async () => {
    // A body-supplied owner would be an endpoint for registering a business in
    // someone else's name.
    const response = await post('/businesses', maria, { ...business, ownerApplicantId: randomUUID() });

    expect(response.statusCode).toBe(400);
  });

  it('lists only the caller’s businesses', async () => {
    await post('/businesses', maria, business);
    await post('/businesses', jose, { ...business, name: 'Jose Hardware', registrationNumber: 'DTI-2' });

    const body = (await get('/businesses', maria)).json<{ data: { name: string }[] }>();

    expect(body.data.map((b) => b.name)).toEqual(['Aling Nena Sari-Sari Store']);
  });

  it('lets a filing reference it', async () => {
    const businessId = (await post('/businesses', maria, business)).json<{ id: string }>().id;

    const filed = await post('/applications', maria, submission({ businessId }));

    expect(filed.statusCode).toBe(201);
    expect(filed.json<{ businessName: string }>().businessName).toBe('Aling Nena Sari-Sari Store');
  });

  it('refuses a filing against someone else’s business', async () => {
    const businessId = (await post('/businesses', jose, business)).json<{ id: string }>().id;

    const filed = await post('/applications', maria, submission({ businessId }));

    expect(filed.statusCode).toBe(422);
  });
});

describe('answering a Letter of Instruction', () => {
  async function underRevision(): Promise<{ applicationId: string; letterId: string; itemId: string }> {
    const applicationId = (await post('/applications', maria, submission())).json<{ id: string }>().id;
    for (const status of ['Received', 'Document Verification', 'Revision Required']) {
      await db.query('update applications set lifecycle_status = $1 where id = $2', [status, applicationId]);
    }
    const officer = randomUUID();
    await db.query(
      `insert into accounts (id, kind, email, email_normalised, password_hash)
       values ($1,'staff','e@lgu.gov.ph','e@lgu.gov.ph','scrypt$1$1$1$a$b')`, [officer],
    );
    const letterId = randomUUID();
    await db.query(
      `insert into letters_of_instruction (id, application_id, issued_at, issued_by)
       values ($1,$2,now(),$3)`,
      [letterId, applicationId, officer],
    );
    const itemId = randomUUID();
    await db.query(
      `insert into instruction_items (id, letter_id, subject, remark)
       values ($1,$2,'Lot plan','The lot plan is not signed by a geodetic engineer.')`,
      [itemId, letterId],
    );
    return { applicationId, letterId, itemId };
  }

  it('accepts a resubmission with no body, because handing back the papers IS the response', async () => {
    // At a counter an applicant hands back the corrected papers; they do not
    // annotate each line of the officer's note. The mobile client posts this
    // with no body at all.
    const { applicationId, letterId } = await underRevision();

    const response = await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('Under Evaluation');
  });

  it('restarts the pledge clock, which is the point of being able to reply', async () => {
    // RA 11032 suspends the clock while the applicant holds the application. If
    // they cannot hand it back, it never restarts.
    const { applicationId, letterId } = await underRevision();

    await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria);

    const row = await db.query<{ pledge_suspended_since: Date | null }>(
      'select pledge_suspended_since from applications where id = $1', [applicationId],
    );
    expect(row.rows[0]!.pledge_suspended_since).toBeNull();
  });

  it('keeps a per-item explanation where the applicant gave one', async () => {
    const { applicationId, letterId, itemId } = await underRevision();

    await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria, {
      responses: [{ itemId, response: 'Sheet S-3 is now signed; see the reuploaded plan.' }],
    });

    const row = await db.query<{ response: string | null }>(
      'select response from instruction_items where id = $1', [itemId],
    );
    expect(row.rows[0]!.response).toContain('signed');
  });

  it('refuses a response against an item that is not open on this letter', async () => {
    // Silently dropping it loses work the applicant did, and leaves the item
    // they meant to answer unanswered.
    const { applicationId, letterId } = await underRevision();

    const response = await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria, {
      responses: [{ itemId: randomUUID(), response: 'Done.' }],
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a letter belonging to someone else’s application', async () => {
    const { letterId } = await underRevision();
    const mine = (await post('/applications', jose, submission())).json<{ id: string }>().id;

    expect((await post(`/applications/${mine}/instructions/${letterId}/resubmit`, jose)).statusCode)
      .toBe(404);
  });

  it('refuses a second resubmission once everything is answered', async () => {
    const { applicationId, letterId } = await underRevision();
    await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria);

    const again = await post(`/applications/${applicationId}/instructions/${letterId}/resubmit`, maria);

    expect(again.statusCode).toBe(422);
    expect(again.json().detail).toMatch(/already been answered/i);
  });
});
