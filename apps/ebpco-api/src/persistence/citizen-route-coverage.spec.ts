import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every citizen-reachable route is either DECLARED in the contract fragment or
 * excused here with a reason.
 *
 * Three routes shipped as working handlers, with recorded samples, and never
 * gained a path in `citizen-endpoints.openapi.yaml`: `PATCH /me`, and both
 * password-reset routes. Each time a lane found it by reading the source
 * instead — which works, and is the thing a contract exists to make
 * unnecessary. The citizen web portal got `PATCH /me` right only by reading the
 * zod schema; citizen-mobile, which works from the contract, would have found
 * nothing and guessed the field names.
 *
 * That is three occurrences of one mistake, so the fix is not to remember
 * harder. Same shape as the reachability register: a route is classified or the
 * build fails, and a NEW route is unclassified by construction.
 *
 * This is deliberately NOT "declare everything". The fragment is the citizen
 * contract, and plenty of routes below are genuinely not part of it. What the
 * register removes is the ability to add one silently.
 */

const ROOT = join(__dirname, '../..');
const FRAGMENT = readFileSync(join(ROOT, 'contract/citizen-endpoints.openapi.yaml'), 'utf8');
const ROUTES = (JSON.parse(
  readFileSync(join(ROOT, 'contract/route-table.json'), 'utf8'),
) as { routes: string[] }).routes;

/** `:permitType` in the router, `{permitType}` in OpenAPI. */
const asPath = (route: string): string =>
  (route.split(' ', 2)[1] ?? '').replace(/:(\w+)/g, '{$1}');

const isStaff = (route: string): boolean => route.includes(' /staff');
const isInfrastructure = (route: string): boolean =>
  / \/(health|ready|version)$/.test(route);

/**
 * Citizen routes deliberately absent from the fragment, and why.
 *
 * A reason here is a claim that a client does not need the path documented to
 * build against it. If that stops being true, the entry moves into the
 * fragment rather than gaining a longer excuse.
 */
const NOT_IN_THE_CITIZEN_CONTRACT: Readonly<Record<string, string>> = {
  // The filing surface. Documented in the FULL contract repository
  // (ebpco-contract), which is the authority for these; the fragment covers
  // what that repository does not yet carry.
  '/applications': 'the filing surface — in ebpco-contract, which is its authority',
  '/applications/{applicationId}': 'reading one filing — in ebpco-contract',
  '/applications/{applicationId}/timeline': 'the filing history — in ebpco-contract',
  '/applications/{applicationId}/cancel': 'withdrawing a filing — in ebpco-contract',
  '/applications/{applicationId}/payments': 'reporting a payment — in ebpco-contract',
  '/applications/{applicationId}/instructions/{letterId}/resubmit':
    'answering a Letter of Instruction — in ebpco-contract',
  '/requirements/{permitType}': 'what a permit type asks for — in ebpco-contract',
  '/businesses': 'the citizen business list — in ebpco-contract',
  '/documents': 'the upload route — in ebpco-contract; the fragment states its LIMITS instead',

  // Reachable, and no citizen client builds a screen from them.
  '/documents/content': 'a signed link is redeemed by the browser, not called by a client',
  '/documents/{documentId}/content': 'minting a signed download link — in ebpco-contract',
  '/auth/revoke': 'sign-out, session revocation — in ebpco-contract',
  '/auth/access-request': 'STAFF asking for access — public because they have no account yet, '
    + 'and not part of any citizen surface',

  // Notifications and devices: a whole subsystem with its own shape.
  '/notifications': 'the notification subsystem — in ebpco-contract',
  '/notifications/{notificationId}/read': 'marking one notice read — in ebpco-contract',
  '/notifications/{notificationId}/resolve': 'clearing an action item — in ebpco-contract',
  '/notification-preferences': 'per-channel notice settings — in ebpco-contract',
  '/devices': 'push registration — in ebpco-contract',
  '/devices/{deviceId}': 'unregistering a handset for push — in ebpco-contract',

  // Self-service identity beyond the profile.
  '/me/contacts': 'contact verification — in ebpco-contract',
  '/me/contacts/{channel}/request': 'asking for a verification code — in ebpco-contract',
  '/me/contacts/{channel}/confirm': 'answering a verification code — in ebpco-contract',
  '/me/mfa': 'MFA is required of STAFF, not of citizens; no citizen screen uses it',
  '/me/mfa/enrol': 'MFA enrolment, a staff concern rather than a citizen one',
  '/me/mfa/activate': 'MFA activation, a staff concern rather than a citizen one',
  '/me/export': 'RA 10173 portability — in ebpco-contract',
  '/me/export/{requestId}': 'checking an export request — in ebpco-contract',
  '/me/export/{requestId}/content': 'downloading a produced export — in ebpco-contract',

  // The document library. IN the fragment is where this belongs and it is
  // going there next; recorded now so the claim is visible rather than lost.
  '/documents/me': 'PENDING: the reusable library. Belongs in the fragment and is not yet in it',
};

describe('every citizen route is declared or excused', () => {
  const citizen = ROUTES.filter((route) => !isStaff(route) && !isInfrastructure(route));
  const declared = new Set(FRAGMENT.match(/^ {2}(\/\S+):/gm)?.map(
    (line) => line.trim().replace(/:$/, '')) ?? []);

  it('classifies every one of them', () => {
    // The gate that would have caught PATCH /me and both reset routes. A new
    // citizen route is neither declared nor excused, so it fails here until
    // somebody says which it is.
    const unclassified = [...new Set(citizen.map(asPath))]
      .filter((path) => !declared.has(path) && NOT_IN_THE_CITIZEN_CONTRACT[path] === undefined)
      .sort();

    expect(unclassified).toEqual([]);
  });

  it('declares no path that does not exist', () => {
    // The other direction, and the one a "does it validate?" check misses: a
    // fragment can promise a path the router never serves, which is worse than
    // silence because a client builds against it.
    const real = new Set(ROUTES.map(asPath));
    const phantom = [...declared].filter((path) => !real.has(path)).sort();

    expect(phantom).toEqual([]);
  });

  it('gives every excuse a reason somebody wrote', () => {
    // An empty string would classify a route while saying nothing, which is
    // the register defeating its own purpose.
    for (const [path, reason] of Object.entries(NOT_IN_THE_CITIZEN_CONTRACT)) {
      expect(`${path}: ${reason.length > 20}`).toBe(`${path}: true`);
    }
  });

  it('excuses nothing that is already declared', () => {
    // A path in both lists is a contradiction, and the stale half survives
    // until somebody trips over it.
    const both = Object.keys(NOT_IN_THE_CITIZEN_CONTRACT).filter((path) => declared.has(path));

    expect(both).toEqual([]);
  });
});
