import {
  ACCESS_ACTIONS, SECURITY_ACTIONS, SECURITY_STREAM_ACTIONS,
  documentSecurityEvent, endedSession, failedSecondFactor, refusedSignIn,
  replayedRefreshToken, startedSession,
} from './security-events';

/**
 * The enumeration guarantee, asserted rather than commented.
 *
 * `authenticate` hashes against a decoy so that "no such account" and "wrong
 * password" burn the same time, and checks a disabled account after the
 * password so neither can be told from the other. Auditing the refusal is the
 * obvious way to undo all of it: an entry carrying an account id says the email
 * matched, one without says it did not, and the presence of the field is the
 * oracle -- readable by every auditor and super-admin.
 */

describe('a refused sign-in identifies nobody', () => {
  it('carries no account id, no subject id and no role', () => {
    const entry = refusedSignIn();

    expect(entry.actorAccountId).toBeNull();
    expect(entry.subjectId).toBeNull();
    expect(entry.actorRole).toBeNull();
    expect(entry.afterState).toBeNull();
  });

  it('takes no arguments, so there is nothing to pass by mistake', () => {
    // The strongest form of the guarantee available in this language: a caller
    // holding an account id has nowhere to put it. A future refactor that adds
    // a parameter here has to delete this line to do it.
    expect(refusedSignIn).toHaveLength(0);
  });

  it('says nothing that varies with the attempt', () => {
    // Two refusals must be indistinguishable. If any field ever depended on
    // WHICH account was tried, comparing two entries would recover it.
    expect(JSON.stringify(refusedSignIn())).toBe(JSON.stringify(refusedSignIn()));
  });
});

describe('a wrong second factor does name the account', () => {
  it('records the account, deliberately', () => {
    // Safe precisely because it is unreachable without the correct password:
    // whoever produced it already knows the account exists. Withholding the id
    // would cost an investigator the most useful field in the most serious
    // case -- a stolen password stopped only by the second factor.
    const entry = failedSecondFactor('acc-1', 'staff');

    expect(entry.actorAccountId).toBe('acc-1');
    expect(entry.outcome).toBe('denied');
  });
});

describe('the streams', () => {
  it('puts a refused sign-in in both access and security', () => {
    // It is the same fact answering two questions: "who tried to get in" and
    // "what looks like an attack". Neither tab is complete without it.
    expect(ACCESS_ACTIONS).toContain(SECURITY_ACTIONS.sessionRefused);
    expect(SECURITY_STREAM_ACTIONS).toContain(SECURITY_ACTIONS.sessionRefused);
  });

  it('keeps a successful sign-in out of the security stream', () => {
    // A security tab that lists every normal sign-in is a tab nobody reads.
    expect(SECURITY_STREAM_ACTIONS).not.toContain(SECURITY_ACTIONS.sessionStarted);
    expect(SECURITY_STREAM_ACTIONS).not.toContain(SECURITY_ACTIONS.sessionEnded);
  });

  it('names every action in the closed list in exactly one of the two sets or the other', () => {
    // Nothing may be defined and then routed nowhere: an action in neither set
    // would be recorded and invisible, which is worse than not recorded, since
    // the table claims to cover it.
    for (const action of Object.values(SECURITY_ACTIONS)) {
      expect(ACCESS_ACTIONS.includes(action) || SECURITY_STREAM_ACTIONS.includes(action))
        .toBe(true);
    }
  });
});

describe('the other entries carry what an investigator needs', () => {
  it('records a session start and a distinguishable everywhere-sign-out', () => {
    expect(startedSession('acc-1', 'applicant').outcome).toBe('allowed');
    // "Signed out here" and "signed out everywhere" are different acts: the
    // second is what someone does when they think a device was taken.
    expect(endedSession('acc-1', 'staff', false).afterState).toEqual({ everywhere: false });
    expect(endedSession('acc-1', 'staff', true).afterState).toEqual({ everywhere: true });
  });

  it('records a replay as failed, not denied, and names the family it revoked', () => {
    const entry = replayedRefreshToken('acc-1', 'fam-1');

    // `denied` is a refusal of something someone asked for. A replay is the
    // system reacting to a possible theft, which is not the same event.
    expect(entry.outcome).toBe('failed');
    expect(entry.afterState).toMatchObject({ familyId: 'fam-1' });
  });

  it('records a document security event against the document, not the account', () => {
    const entry = documentSecurityEvent('acc-1', 'doc-1', 'malware-detected', 'EICAR');

    // The subject is what was acted on. An investigator asking "what happened
    // to this file" must find it by the file.
    expect(entry.subjectType).toBe('document');
    expect(entry.subjectId).toBe('doc-1');
    expect(entry.actorAccountId).toBe('acc-1');
  });
});
