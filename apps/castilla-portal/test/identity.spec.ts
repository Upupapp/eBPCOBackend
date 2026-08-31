import { IdentityService } from '../src/identity/identity.service';
import { StaffRole, grantsAnyWrite, scopesFor } from '../src/identity/roles';
import { Harness, harness } from './http-harness';

/** TAB 11 — staff authentication, and the negative-path matrix. */

let api: Harness;
let identity: IdentityService;

const PASSWORD = 'a-long-enough-passphrase-for-a-test';

const ACCOUNTS: { email: string; role: StaffRole }[] = [
  { email: 'viewer@castilla.gov.ph', role: 'viewer' },
  { email: 'editor@castilla.gov.ph', role: 'content-editor' },
  { email: 'approver@castilla.gov.ph', role: 'content-approver' },
  { email: 'approver2@castilla.gov.ph', role: 'content-approver' },
  { email: 'publisher@castilla.gov.ph', role: 'announcements-publisher' },
  { email: 'admin@castilla.gov.ph', role: 'administrator' },
];

const tokens = new Map<StaffRole | 'approver2', string>();

interface Response { statusCode: number; body: string; headers: Record<string, unknown> }

const call = (
  method: string, url: string, token?: string, payload?: unknown,
): Promise<Response> => (api.app.getHttpAdapter().getInstance() as {
  inject: (o: {
    method: string; url: string; headers?: Record<string, string>; payload?: unknown;
  }) => Promise<Response>;
}).inject({
  method, url,
  ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  ...(payload === undefined ? {} : { payload }),
});

beforeAll(async () => {
  api = await harness();
  identity = new IdentityService(api.db);
  for (const account of ACCOUNTS) {
    await identity.createAccount(account.email, account.email, account.role, PASSWORD);
    const result = await identity.signIn(account.email, PASSWORD);
    if (!result.ok) throw new Error(`could not sign in ${account.email}`);
    tokens.set(account.email === 'approver2@castilla.gov.ph' ? 'approver2' : account.role,
      result.token);
  }
}, 300000);

afterAll(async () => { await api.close(); });

describe('the role model is the portal’s own', () => {
  it('grants the viewer no write scope at all', () => {
    // Named as a fact rather than inferred from a permission table: a sibling
    // project's read-only guarantee turned out to be enforced by a blindness
    // bug, so this asserts the RULE, and the sweep below asserts the behaviour.
    expect(grantsAnyWrite('viewer')).toBe(false);
    expect(scopesFor('viewer')).toEqual(['content:read']);
  });

  it('does not let an administrator edit content or confirm facts', () => {
    // Managing accounts is not a licence to change what the site says. Bundling
    // them makes four-eyes optional for the account most likely to be shared.
    expect(scopesFor('administrator')).not.toContain('content:confirm');
    expect(scopesFor('administrator')).not.toContain('pages:edit');
  });

  it('does not reuse the permit system’s role vocabulary', () => {
    // TAB 11's guard. Those roles model permit processing, not editing prose.
    const roles = ACCOUNTS.map((a) => a.role);
    for (const permitRole of ['receiving', 'assessor', 'releasing', 'evaluator', 'cashier']) {
      expect(roles).not.toContain(permitRole);
    }
  });
});

describe('signing in tells an attacker nothing', () => {
  it('answers identically for a wrong password and an unknown account', async () => {
    const wrongPassword = await call('POST', '/session', undefined,
      { email: 'viewer@castilla.gov.ph', password: 'not-the-password' });
    const noSuchAccount = await call('POST', '/session', undefined,
      { email: 'nobody@castilla.gov.ph', password: 'not-the-password' });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchAccount.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(noSuchAccount.body);
  });

  it('logs the real reason for the operator without returning it', async () => {
    await call('POST', '/session', undefined,
      { email: 'ghost@castilla.gov.ph', password: 'x' });

    const attempts = await api.db.query<{ reason: string; succeeded: boolean }>(
      "select reason, succeeded from sign_in_attempts where email = 'ghost@castilla.gov.ph'");

    expect(attempts.rows[0]?.succeeded).toBe(false);
    expect(attempts.rows[0]?.reason).toBe('no such account');
  });

  it('locks an account out after repeated failures', async () => {
    await identity.createAccount('locked@castilla.gov.ph', 'Locked', 'viewer', PASSWORD);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await identity.signIn('locked@castilla.gov.ph', 'wrong');
    }

    // The correct password now fails too, and says nothing about why.
    const result = await identity.signIn('locked@castilla.gov.ph', PASSWORD);

    expect(result.ok).toBe(false);
    const locked = await api.db.query<{ locked_until: Date | null }>(
      "select locked_until from staff_accounts where email = 'locked@castilla.gov.ph'");
    expect(locked.rows[0]!.locked_until).not.toBeNull();
  });
});

describe('sign-out actually revokes', () => {
  it('rejects the credential when it is replayed afterwards', async () => {
    // TAB 11's criterion, and a defect that bit a sibling project in this
    // portfolio. Tested by replay, not by reading a flag.
    const result = await identity.signIn('editor@castilla.gov.ph', PASSWORD);
    if (!result.ok) throw new Error('sign-in failed');

    expect((await call('GET', '/session', result.token)).statusCode).toBe(200);

    expect((await call('DELETE', '/session', result.token)).statusCode).toBe(204);

    const replayed = await call('GET', '/session', result.token);
    expect(replayed.statusCode).toBe(404);
  });

  it('leaves no session row behind to be resurrected', async () => {
    const result = await identity.signIn('editor@castilla.gov.ph', PASSWORD);
    if (!result.ok) throw new Error('sign-in failed');
    await identity.signOut(result.token);

    // The row IS the session. There is no denylist that a later code path
    // could forget to consult.
    expect(await identity.authenticate(result.token)).toBeNull();
  });

  it('refuses a session whose account has since been disabled', async () => {
    const id = await identity.createAccount(
      'temp@castilla.gov.ph', 'Temp', 'content-editor', PASSWORD);
    const result = await identity.signIn('temp@castilla.gov.ph', PASSWORD);
    if (!result.ok) throw new Error('sign-in failed');

    await api.db.query('update staff_accounts set disabled_at = now() where id = $1', [id]);

    // Effective on the next request, not when the session happens to expire.
    expect(await identity.authenticate(result.token)).toBeNull();
  });
});

describe('a read scope never permits a write', () => {
  /**
   * Every non-GET route the application actually serves, read out of the
   * router rather than hand-listed.
   *
   * TAB 11 says to demonstrate this endpoint by endpoint and NOT by reading the
   * permission table. A hand-written list is the same mistake one step later: it
   * cannot include the route somebody adds next week.
   */
  const writeRoutes = (): { method: string; url: string }[] => {
    const server = api.app.getHttpAdapter().getInstance() as {
      printRoutes: () => string;
    };
    const printed = server.printRoutes();
    const found: { method: string; url: string }[] = [];
    // Fastify prints a tree; recover paths from the router's own listing.
    const stack: string[] = [];
    for (const line of printed.split('\n')) {
      const match = /^([│\s├└─]*)([^\s(]*)\s*(?:\((.*)\))?/.exec(line);
      if (match === null) continue;
      const depth = Math.floor(match[1]!.length / 4);
      const segment = match[2] ?? '';
      const methods = match[3];
      stack.length = depth;
      stack.push(segment);
      if (methods !== undefined && methods !== '') {
        const url = stack.join('').replace(/\/+/g, '/');
        for (const method of methods.split(',').map((m) => m.trim())) {
          if (method !== 'GET' && method !== 'HEAD' && method !== '') {
            found.push({ method, url });
          }
        }
      }
    }
    return found;
  };

  it('found the write routes to sweep, so the sweep is not vacuous', () => {
    const routes = writeRoutes();

    // If this ever reads 0 the sweep below proves nothing at all.
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * The ONE exemption, named and justified rather than filtered quietly.
   *
   * `DELETE /session` ends the caller's own session. Every account must be able
   * to sign out, including a read-only one, and ending your own session is not
   * a write to anything the public reads. It is exempted here and its safety is
   * asserted separately below — a sibling project's read-only guarantee turned
   * out to be enforced by a blindness bug, and an unexplained skip in a sweep
   * is how that begins.
   */
  const OWN_SESSION_ONLY = 'DELETE /session';

  it('refuses the read-only account at every single one', async () => {
    // A fresh session, because the sweep signs itself out along the way.
    const signedIn = await identity.signIn('viewer@castilla.gov.ph', PASSWORD);
    if (!signedIn.ok) throw new Error('viewer sign-in failed');
    const viewer = signedIn.token;
    const refused: string[] = [];
    const accepted: string[] = [];

    for (const route of writeRoutes()) {
      if (`${route.method} ${route.url}` === OWN_SESSION_ONLY) continue;
      // A concrete URL: a parameterised path must still be refused before
      // anything looks the parameter up.
      const url = route.url.replace(/:[A-Za-z]+/g, 'anything').replace(/\*/g, 'anything');
      const response = await call(route.method, url, viewer, {
        title: 'x', body: 'x', slug: 'x', category: 'x', isPlaceholder: false,
      });

      if ([401, 403, 404].includes(response.statusCode)) refused.push(url);
      else accepted.push(`${route.method} ${url} -> ${response.statusCode}`);
    }

    expect(accepted).toEqual([]);
    expect(refused.length).toBeGreaterThanOrEqual(5);
  });

  it('lets the read-only account end ONLY its own session', async () => {
    // The exemption's justification, asserted rather than assumed. A viewer may
    // sign itself out; it may not reach anyone else's session, and there is no
    // route by which it could — sign-out takes the token from the header, never
    // an account id from the caller.
    const mine = await identity.signIn('viewer@castilla.gov.ph', PASSWORD);
    const theirs = await identity.signIn('editor@castilla.gov.ph', PASSWORD);
    if (!mine.ok || !theirs.ok) throw new Error('sign-in failed');

    expect((await call('DELETE', '/session', mine.token)).statusCode).toBe(204);

    expect(await identity.authenticate(mine.token)).toBeNull();
    // The other account's session is untouched.
    expect(await identity.authenticate(theirs.token)).not.toBeNull();
  });

  it('refuses an anonymous caller at every one, indistinguishably from absent', async () => {
    // TAB 11's criterion: an authorisation failure and a missing record are the
    // same to an unauthenticated caller. Probing tells them nothing.
    for (const route of writeRoutes()) {
      const url = route.url.replace(/:[A-Za-z]+/g, 'anything').replace(/\*/g, 'anything');
      const response = await call(route.method, url, undefined, { title: 'x' });

      if (url === '/session') continue; // sign-in is public by necessity
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('the four-eyes rule is enforced by authorisation', () => {
  const office = async (): Promise<string> =>
    (await api.db.query<{ id: string }>(
      "select id from offices where slug = 'municipal-treasurer'")).rows[0]!.id;

  const propose = async (token: string, fieldName: string): Promise<string> => {
    const response = await call('POST', '/staff/workflow/proposals', token, {
      entityType: 'office', entityId: await office(), fieldName,
      proposedValue: '(056) 123-4567',
      sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
      sourcedOn: '2026-08-31', method: 'official-document',
    });
    expect(response.statusCode).toBe(201);
    return (JSON.parse(response.body) as { proposalId: string }).proposalId;
  };

  it('refuses an approver confirming their own contact-field proposal', async () => {
    // TAB 11's criterion. Refused by AUTHORISATION, before the handler runs.
    const approver = tokens.get('content-approver')!;
    const id = await propose(approver, 'contact.telephone');

    const response = await call('POST', `/staff/workflow/proposals/${id}/confirm`, approver);

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('other than the person who made it');
  });

  it('accepts a different approver', async () => {
    // The other half: without it the refusal above passes against a rule that
    // refuses everyone.
    const id = await propose(tokens.get('content-approver')!, 'contact.email');

    const response = await call(
      'POST', `/staff/workflow/proposals/${id}/confirm`, tokens.get('approver2'));

    expect(response.statusCode).toBe(200);
  });

  it('refuses an editor confirming anything, own proposal or not', async () => {
    const id = await propose(tokens.get('content-editor')!, 'contact.location');

    const response = await call(
      'POST', `/staff/workflow/proposals/${id}/confirm`, tokens.get('content-editor'));

    expect(response.statusCode).toBe(403);
  });

  it('takes the actor from the session, never from the body', async () => {
    // A body-supplied author is a four-eyes rule anyone defeats by typing a
    // colleague's address.
    const approver = tokens.get('content-approver')!;
    const response = await call('POST', '/staff/workflow/proposals', approver, {
      entityType: 'office', entityId: await office(), fieldName: 'contact.hours',
      proposedValue: 'Monday-Friday',
      sourceDescription: "the LGU Citizen's Charter, page 12, read at the counter",
      sourcedOn: '2026-08-31', method: 'official-document',
      proposedBy: 'someone.else@castilla.gov.ph',
    });

    // `.strict()` refuses the undeclared key outright rather than ignoring it.
    expect(response.statusCode).toBe(400);
  });
});

describe('scopes are checked per route, not per role name', () => {
  it('lets the announcements publisher publish', async () => {
    const publisher = tokens.get('announcements-publisher')!;

    const drafted = await call('POST', '/staff/announcements', publisher, {
      slug: 'water-interruption', title: 'Water interruption',
      body: 'Supply will be interrupted on Monday.', category: 'advisory',
    });

    expect(drafted.statusCode).toBe(201);
  });

  it('does not let the announcements publisher edit a page', async () => {
    const response = await call('PUT', '/staff/pages/mission',
      tokens.get('announcements-publisher'),
      { title: 'Mission', body: 'Rewritten.', isPlaceholder: false });

    expect(response.statusCode).toBe(403);
  });

  it('does not let a content editor publish an announcement', async () => {
    const response = await call('POST', '/staff/announcements', tokens.get('content-editor'), {
      slug: 'unauthorised', title: 'x', body: 'x', category: 'advisory',
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets a content editor edit a page', async () => {
    const response = await call('PUT', '/staff/pages/mission', tokens.get('content-editor'),
      { title: 'Mission', body: 'A newly written mission.', isPlaceholder: false });

    expect(response.statusCode).toBe(200);
  });
});
