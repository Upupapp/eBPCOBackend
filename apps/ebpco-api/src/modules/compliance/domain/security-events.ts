/**
 * The closed list of security and access events this service records.
 *
 * Owner decision D-6, 2026-08-29: the API does NOT become a log store. Access
 * and security are records of WHO DID WHAT, so they go in the hash-chained
 * audit table that already carries retention, the PII register and the erasure
 * list. Error and system-event logs are operational telemetry and stay in the
 * host's log stack, where they remain readable when the database is the thing
 * that is broken.
 *
 * ── The enumeration rule, expressed as code ─────────────────────────────
 *
 * `authenticate` takes deliberate trouble to make "no such account" and "wrong
 * password" indistinguishable: it hashes against a decoy so both paths burn the
 * same ~100ms, and it checks a disabled account AFTER the password so neither
 * can be told from the other.
 *
 * Auditing a refused sign-in threatens all of that. An entry carrying an
 * account id says the email matched; one without says it did not, and the
 * PRESENCE OF THE FIELD becomes the oracle the timing defence was built to
 * close -- readable by every auditor and super-admin. So a refused sign-in
 * carries no account id, ever, and `refusedSignIn` below is the only way to
 * construct one. The rule is a function rather than a comment because a comment
 * cannot fail a build.
 *
 * The attempted email is not recorded either. It would put attacker-supplied
 * strings, and real people's addresses, into an append-only table.
 */

export const SECURITY_ACTIONS = {
  sessionStarted: 'session.started',
  sessionEnded: 'session.ended',
  sessionRefused: 'session.refused',
  sessionReplayDetected: 'session.replay-detected',
  mfaFailed: 'mfa.failed',
  documentSecurity: 'document.security-event',
  authorisationRefused: 'authorisation.refused',

  // ── Access administration ───────────────────────────────────────────
  //
  // Who was given authority over permit records, by whom, and over which
  // forms. These belong on the SECURITY stream rather than the access one:
  // 'someone signed in' is routine, and 'someone was granted the power to
  // decide applications' is the event a reviewer is actually looking for.
  accessRequested: 'access.requested',
  accessApproved: 'access.approved',
  accessRejected: 'access.rejected',
  accessLevelChanged: 'access.level-changed',
  accessFormsChanged: 'access.forms-changed',
  accessDisabled: 'access.disabled',
  accessEnabled: 'access.enabled',
} as const;

export type SecurityAction = (typeof SECURITY_ACTIONS)[keyof typeof SECURITY_ACTIONS];

/** Which stream a portal tab would draw an action into. */
export const ACCESS_ACTIONS: readonly SecurityAction[] = [
  SECURITY_ACTIONS.sessionStarted,
  SECURITY_ACTIONS.sessionEnded,
  SECURITY_ACTIONS.sessionRefused,
];

export const SECURITY_STREAM_ACTIONS: readonly SecurityAction[] = [
  SECURITY_ACTIONS.authorisationRefused,
  SECURITY_ACTIONS.accessRequested,
  SECURITY_ACTIONS.accessApproved,
  SECURITY_ACTIONS.accessRejected,
  SECURITY_ACTIONS.accessLevelChanged,
  SECURITY_ACTIONS.accessFormsChanged,
  SECURITY_ACTIONS.accessDisabled,
  SECURITY_ACTIONS.accessEnabled,
  SECURITY_ACTIONS.sessionRefused,
  SECURITY_ACTIONS.sessionReplayDetected,
  SECURITY_ACTIONS.mfaFailed,
  SECURITY_ACTIONS.documentSecurity,
];

export interface SecurityEntry {
  readonly action: SecurityAction;
  readonly subjectType: 'account' | 'document';
  readonly subjectId: string | null;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly actorAccountId: string | null;
  readonly actorRole: string | null;
  readonly afterState: Record<string, unknown> | null;
}

export function startedSession(accountId: string, kind: string): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.sessionStarted,
    subjectType: 'account', subjectId: accountId, outcome: 'allowed',
    actorAccountId: accountId, actorRole: kind, afterState: null,
  };
}

export function endedSession(accountId: string, kind: string, everywhere: boolean): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.sessionEnded,
    subjectType: 'account', subjectId: accountId, outcome: 'allowed',
    actorAccountId: accountId, actorRole: kind,
    // "Signed out here" and "signed out everywhere" are different acts: the
    // second is what someone does when they think a device was taken.
    afterState: { everywhere },
  };
}

/**
 * A refused sign-in. Takes NO arguments, and that is the whole point.
 *
 * Everything an investigator needs -- when, from where, how many in a row --
 * comes from the source address and timestamp the audit service fills in
 * itself. Everything that would identify the target is exactly what must not
 * be here.
 */
export function refusedSignIn(): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.sessionRefused,
    subjectType: 'account', subjectId: null, outcome: 'denied',
    actorAccountId: null, actorRole: null, afterState: null,
  };
}

/**
 * A wrong second factor.
 *
 * This one DOES name the account, and safely: it can only be reached after a
 * correct password, so anyone who can produce it already knows the account
 * exists and holds its password. Withholding the id here would cost an
 * investigator the single most useful field in the most serious case -- someone
 * with a stolen password, stopped only by the second factor.
 */
export function failedSecondFactor(accountId: string, kind: string): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.mfaFailed,
    subjectType: 'account', subjectId: accountId, outcome: 'denied',
    actorAccountId: accountId, actorRole: kind, afterState: null,
  };
}

export function replayedRefreshToken(accountId: string, familyId: string): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.sessionReplayDetected,
    subjectType: 'account', subjectId: accountId, outcome: 'failed',
    actorAccountId: accountId, actorRole: null,
    afterState: { familyId, treatAs: 'possible token theft; the family was revoked' },
  };
}

/**
 * An authenticated caller refused a route.
 *
 * Records the route PATTERN, not the path as requested: the guard refuses on
 * the ROUTE, before any record is looked at, so a specific id in the entry
 * would suggest a target was checked when none was. Ids are masked rather than
 * dropped so the shape stays readable -- `/staff/applications/:id/transitions`
 * says what was reached for.
 *
 * `debouncedWindowSeconds` is carried in the entry because a reader has to know
 * what one row represents. Without it, ten entries could mean ten refusals or
 * ten thousand, and the difference changes what an investigator concludes.
 */
export function refusedAuthorisation(options: {
  accountId: string; kind: string; path: string; reason: string; windowSeconds: number;
}): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.authorisationRefused,
    subjectType: 'account', subjectId: options.accountId, outcome: 'denied',
    actorAccountId: options.accountId, actorRole: options.kind,
    afterState: {
      route: maskIds(options.path),
      reason: options.reason,
      debouncedWindowSeconds: options.windowSeconds,
      note: 'at most one entry per account per window; further refusals in that '
        + 'window are not recorded here',
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function maskIds(path: string): string {
  // Query strings are dropped whole rather than masked. They can carry an email
  // -- `?email=` on a lookup -- and an append-only table is the wrong place to
  // discover that later.
  const withoutQuery = path.split('?')[0] ?? '';
  return withoutQuery.replace(UUID, ':id').replace(/\/\d+(?=\/|$)/g, '/:n');
}

export function documentSecurityEvent(
  accountId: string | null, documentId: string | null, type: string, detail: string,
): SecurityEntry {
  return {
    action: SECURITY_ACTIONS.documentSecurity,
    subjectType: 'document', subjectId: documentId, outcome: 'denied',
    actorAccountId: accountId, actorRole: null,
    afterState: { type, detail },
  };
}
