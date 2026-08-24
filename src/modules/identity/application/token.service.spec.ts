import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import { InMemorySessionRepository } from '../infrastructure/in-memory-session.repository';
import { ACCESS_TOKEN_TTL_SECONDS } from '../domain/tokens';
import { SecurityEvent, TOKEN_AUDIENCE, TOKEN_ISSUER, TokenError, TokenService } from './token.service';

// Absolute, not relative: these tokens are verified against a pinned clock, and
// a lifetime relative to the real clock would expire before it.
const FAR_FUTURE = Math.floor(new Date('2027-01-01T00:00:00Z').getTime() / 1000);

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

function build(nowRef = { value: new Date('2026-08-19T12:00:00Z') }) {
  const sessions = new InMemorySessionRepository();
  const events: SecurityEvent[] = [];
  const service = new TokenService({
    signingKey: KEY,
    sessions,
    clock: () => nowRef.value,
    onSecurityEvent: (event) => events.push(event),
  });
  return { service, sessions, events, nowRef };
}

const claims = { sub: 'account-1', sid: 'family-1', kind: 'applicant' as const, scopes: ['applications:read' as const] };

describe('access tokens', () => {
  it('round-trips its claims', async () => {
    const { service } = build();
    const { token, expiresIn } = await service.issueAccessToken(claims);

    await expect(service.verifyAccessToken(token)).resolves.toEqual(claims);
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('issues a token that expires when the configured lifetime says', async () => {
    // The value is now a deployment decision, so the thing to assert is that
    // the configured number reaches the token rather than that it equals 900.
    const service = new TokenService({
      signingKey: KEY, sessions: new InMemorySessionRepository(), accessTtlSeconds: 300,
    });

    const issued = await service.issueAccessToken({
      sub: randomUUID(), sid: randomUUID(), kind: 'applicant', scopes: [],
    });

    expect(issued.expiresIn).toBe(300);
  });

  it('tells the client the lifetime, so a client that wanted to refresh early could', async () => {
    // The mobile client refreshes reactively today — it discovers expiry from a
    // 401. `expiresIn` is what a client would need to stop doing that, and
    // returning it costs nothing.
    const service = new TokenService({ signingKey: KEY, sessions: new InMemorySessionRepository() });

    const issued = await service.issueAccessToken({
      sub: randomUUID(), sid: randomUUID(), kind: 'applicant', scopes: [],
    });

    expect(issued.expiresIn).toBeGreaterThan(0);
    expect(issued.expiresIn).toBeLessThanOrEqual(900);
  });

  it('refuses a lifetime above the ceiling', () => {
    // The ceiling bounds how long a revoked session keeps working. Raising it
    // is not a tuning decision.
    expect(() =>
      new TokenService({ signingKey: KEY, sessions: new InMemorySessionRepository(), accessTtlSeconds: 3600 }),
    ).toThrow(/may not exceed/);
  });

  it('rejects a token signed with a different key', async () => {
    const { service } = build();
    const forged = await new SignJWT({ sid: 'x', kind: 'applicant', scopes: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('account-1')
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime(FAR_FUTURE)
      .sign(OTHER_KEY);

    await expect(service.verifyAccessToken(forged)).rejects.toMatchObject({ failure: 'signature' });
  });

  it('rejects an unsigned token claiming alg: none', async () => {
    // The classic JWT attack: strip the signature and claim the algorithm is
    // "none". Pinning algorithms is what stops it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'account-1', sid: 'x', kind: 'staff', scopes: ['staff:approve'], iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, exp: 9_999_999_999 }),
    ).toString('base64url');

    await expect(build().service.verifyAccessToken(`${header}.${payload}.`)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects a token that has expired', async () => {
    const nowRef = { value: new Date('2026-08-19T12:00:00Z') };
    const { service } = build(nowRef);
    const { token } = await service.issueAccessToken(claims);

    nowRef.value = new Date('2026-08-19T12:15:01Z');

    await expect(service.verifyAccessToken(token)).rejects.toMatchObject({ failure: 'expired' });
  });

  it('does not allow clock skew to extend a token', async () => {
    const nowRef = { value: new Date('2026-08-19T12:00:00Z') };
    const { service } = build(nowRef);
    const { token } = await service.issueAccessToken(claims);

    nowRef.value = new Date(nowRef.value.getTime() + (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);

    await expect(service.verifyAccessToken(token)).rejects.toMatchObject({ failure: 'expired' });
  });

  it('rejects a token issued for another audience', async () => {
    const { service } = build();
    const foreign = await new SignJWT({ sid: 'x', kind: 'applicant', scopes: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('account-1')
      .setIssuer(TOKEN_ISSUER)
      .setAudience('some-other-service')
      .setExpirationTime(FAR_FUTURE)
      .sign(KEY);

    await expect(service.verifyAccessToken(foreign)).rejects.toBeInstanceOf(TokenError);
  });

  it.each([['empty', ''], ['not a JWT', 'not-a-token'], ['two segments', 'aaa.bbb']])(
    'rejects a malformed token: %s',
    async (_label, token) => {
      await expect(build().service.verifyAccessToken(token)).rejects.toMatchObject({ failure: 'malformed' });
    },
  );

  it('rejects a validly signed token whose claims are the wrong shape', async () => {
    const { service } = build();
    const odd = await new SignJWT({ sid: 'x', kind: 'wizard', scopes: 'all' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('account-1')
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime(FAR_FUTURE)
      .sign(KEY);

    await expect(service.verifyAccessToken(odd)).rejects.toMatchObject({ failure: 'malformed' });
  });
});

describe('refresh token rotation', () => {
  it('issues a token that can be exchanged once', async () => {
    const { service } = build();
    const first = await service.startSession('account-1');
    const second = await service.rotate(first.presented);

    expect(second.presented).not.toBe(first.presented);
    expect(second.familyId).toBe(first.familyId);
  });

  it('never stores the secret it hands out', async () => {
    const { service, sessions } = build();
    const issued = await service.startSession('account-1');
    const stored = await sessions.findById(issued.id);

    expect(stored).not.toBeNull();
    expect(issued.presented).toContain(stored!.id);
    expect(issued.presented).not.toContain(stored!.secretDigest);
  });

  it('rejects a token whose secret is wrong, even with a real id', async () => {
    const { service } = build();
    const issued = await service.startSession('account-1');

    await expect(service.rotate(`${issued.id}.wrong-secret`)).rejects.toMatchObject({ failure: 'signature' });
  });

  it('rejects an unknown token id', async () => {
    await expect(build().service.rotate('no-such-id.secret')).rejects.toMatchObject({ failure: 'unknown' });
  });

  it.each([['no separator', 'abcdef'], ['empty id', '.secret'], ['empty secret', 'id.']])(
    'rejects a malformed refresh token: %s',
    async (_label, token) => {
      await expect(build().service.rotate(token)).rejects.toMatchObject({ failure: 'malformed' });
    },
  );

  it('rejects an expired refresh token', async () => {
    const nowRef = { value: new Date('2026-08-19T12:00:00Z') };
    const { service } = build(nowRef);
    const issued = await service.startSession('account-1');

    nowRef.value = new Date(issued.expiresAt.getTime() + 1000);

    await expect(service.rotate(issued.presented)).rejects.toMatchObject({ failure: 'expired' });
  });
});

describe('replay detection', () => {
  // The point of the whole design. A refresh token is single-use; a second
  // presentation is either a bad retry or a theft, and there is no way to tell
  // them apart, so the safe reading is theft.

  it('revokes the entire family when a token is presented twice', async () => {
    const { service } = build();
    const first = await service.startSession('account-1');
    const second = await service.rotate(first.presented);

    await expect(service.rotate(first.presented)).rejects.toMatchObject({ failure: 'replayed' });

    // The thief is signed out -- and so is the legitimate holder, who will
    // notice, sign in again, and thereby be safe. Honouring the replay would
    // leave the thief with a permanent session.
    await expect(service.rotate(second.presented)).rejects.toMatchObject({ failure: 'revoked' });
  });

  it('raises a security event naming the account and family', async () => {
    const { service, events } = build();
    const first = await service.startSession('account-1');
    await service.rotate(first.presented);

    await expect(service.rotate(first.presented)).rejects.toBeInstanceOf(TokenError);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'refresh-token-replayed',
      accountId: 'account-1',
      familyId: first.familyId,
    });
  });

  it('leaves other sessions of the same account alone', async () => {
    // A replay on the phone must not sign the applicant out of the browser.
    const { service } = build();
    const phone = await service.startSession('account-1');
    const browser = await service.startSession('account-1');

    await service.rotate(phone.presented);
    await expect(service.rotate(phone.presented)).rejects.toMatchObject({ failure: 'replayed' });

    await expect(service.rotate(browser.presented)).resolves.toBeDefined();
  });

  it('does not raise a security event for an ordinary wrong secret', async () => {
    // A typo'd or truncated token is not evidence of theft.
    const { service, events } = build();
    const issued = await service.startSession('account-1');

    await expect(service.rotate(`${issued.id}.wrong`)).rejects.toBeInstanceOf(TokenError);
    expect(events).toHaveLength(0);
  });
});

describe('revocation', () => {
  it('ends one session', async () => {
    const { service } = build();
    const issued = await service.startSession('account-1');

    await service.endSession(issued.familyId);

    await expect(service.rotate(issued.presented)).rejects.toMatchObject({ failure: 'revoked' });
  });

  it('ends every session of an account', async () => {
    const { service } = build();
    const phone = await service.startSession('account-1');
    const browser = await service.startSession('account-1');
    const somebodyElse = await service.startSession('account-2');

    await service.endAllSessions('account-1');

    await expect(service.rotate(phone.presented)).rejects.toMatchObject({ failure: 'revoked' });
    await expect(service.rotate(browser.presented)).rejects.toMatchObject({ failure: 'revoked' });
    await expect(service.rotate(somebodyElse.presented)).resolves.toBeDefined();
  });
});
