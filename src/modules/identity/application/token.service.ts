import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

import { Scope } from '../domain/account';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenClaims,
  IssuedRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  StoredRefreshToken,
  formatRefreshToken,
  mintRefreshSecret,
  parseRefreshToken,
  refreshSecretMatches,
} from '../domain/tokens';
import { SessionRepository } from './session.repository';

export const TOKEN_ISSUER = 'ebpco-api';
export const TOKEN_AUDIENCE = 'ebpco';

/** Why a presented token was not honoured. Never shown to the caller in this detail. */
export type TokenFailure =
  | 'malformed'
  | 'expired'
  | 'signature'
  | 'unknown'
  | 'revoked'
  | 'replayed';

export class TokenError extends Error {
  constructor(readonly failure: TokenFailure) {
    super(`token rejected: ${failure}`);
    this.name = 'TokenError';
  }
}

export interface SecurityEvent {
  readonly type: 'refresh-token-replayed' | 'family-revoked';
  readonly accountId: string;
  readonly familyId: string;
  readonly at: Date;
  readonly detail: string;
}

export type SecurityEventSink = (event: SecurityEvent) => void;

export interface TokenServiceOptions {
  readonly signingKey: Uint8Array;
  readonly sessions: SessionRepository;
  readonly clock?: () => Date;
  readonly onSecurityEvent?: SecurityEventSink;
  readonly accessTtlSeconds?: number;
  readonly refreshTtlSeconds?: number;
}

export class TokenService {
  private readonly signingKey: Uint8Array;
  private readonly sessions: SessionRepository;
  private readonly clock: () => Date;
  private readonly onSecurityEvent: SecurityEventSink;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(options: TokenServiceOptions) {
    this.signingKey = options.signingKey;
    this.sessions = options.sessions;
    this.clock = options.clock ?? (() => new Date());
    this.onSecurityEvent = options.onSecurityEvent ?? (() => undefined);
    this.accessTtl = options.accessTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTtl = options.refreshTtlSeconds ?? REFRESH_TOKEN_TTL_SECONDS;

    if (this.accessTtl > ACCESS_TOKEN_TTL_SECONDS) {
      // The ceiling is the security property: it bounds how long a revoked
      // session keeps working. Raising it is not a tuning decision.
      throw new Error(`access token lifetime may not exceed ${ACCESS_TOKEN_TTL_SECONDS}s`);
    }
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const now = this.clock();
    const token = await new SignJWT({ sid: claims.sid, kind: claims.kind, scopes: claims.scopes })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + this.accessTtl)
      .sign(this.signingKey);

    return { token, expiresIn: this.accessTtl };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        // Pinned, so a token whose header claims a different algorithm is
        // rejected rather than verified under it. `alg: none` and
        // algorithm-confusion attacks both die here.
        algorithms: ['HS256'],
        clockTolerance: 0,
        currentDate: this.clock(),
      });

      const { sub, sid, kind, scopes } = payload as Record<string, unknown>;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        (kind !== 'applicant' && kind !== 'staff') ||
        !Array.isArray(scopes)
      ) {
        throw new TokenError('malformed');
      }

      return { sub, sid, kind, scopes: scopes as Scope[] };
    } catch (error) {
      if (error instanceof TokenError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') throw new TokenError('expired');
      if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') throw new TokenError('signature');
      throw new TokenError('malformed');
    }
  }

  /** Starts a new session. The returned family id becomes the access token's `sid`. */
  async startSession(accountId: string): Promise<IssuedRefreshToken> {
    return this.mint(accountId, randomUUID());
  }

  /**
   * Exchanges a refresh token for a new pair, rotating it.
   *
   * The replay branch is the point of the whole design. A refresh token is
   * single-use; if one that has already been exchanged is presented again,
   * either the client is retrying badly or the token was stolen. There is no
   * way to tell the two apart, so the safe reading is theft: the entire family
   * is revoked, which signs out whoever holds it -- the attacker AND the
   * legitimate user, who will notice, sign in again, and thereby be safe.
   * Honouring it instead would leave a thief with a permanent session.
   */
  async rotate(presented: string): Promise<IssuedRefreshToken> {
    const parsed = parseRefreshToken(presented);
    if (parsed === null) throw new TokenError('malformed');

    const stored = await this.sessions.findById(parsed.id);
    if (stored === null) throw new TokenError('unknown');

    if (!refreshSecretMatches(parsed.secret, stored.secretDigest)) {
      throw new TokenError('signature');
    }

    const now = this.clock();

    if (stored.consumedAt !== null) {
      await this.sessions.revokeFamily(stored.familyId, now);
      this.onSecurityEvent({
        type: 'refresh-token-replayed',
        accountId: stored.accountId,
        familyId: stored.familyId,
        at: now,
        detail:
          'A refresh token was presented a second time. The whole family was revoked; ' +
          'treat as a possible token theft.',
      });
      throw new TokenError('replayed');
    }

    if (stored.revokedAt !== null) throw new TokenError('revoked');
    if (stored.expiresAt.getTime() <= now.getTime()) throw new TokenError('expired');

    await this.sessions.markConsumed(stored.id, now);
    return this.mint(stored.accountId, stored.familyId);
  }

  async endSession(familyId: string): Promise<void> {
    await this.sessions.revokeFamily(familyId, this.clock());
  }

  async endAllSessions(accountId: string): Promise<number> {
    return this.sessions.revokeAllForAccount(accountId, this.clock());
  }

  private async mint(accountId: string, familyId: string): Promise<IssuedRefreshToken> {
    const now = this.clock();
    const id = randomUUID();
    const { secret, digest } = mintRefreshSecret();
    const expiresAt = new Date(now.getTime() + this.refreshTtl * 1000);

    const stored: StoredRefreshToken = {
      id,
      familyId,
      accountId,
      secretDigest: digest,
      issuedAt: now,
      expiresAt,
      consumedAt: null,
      revokedAt: null,
    };
    await this.sessions.save(stored);

    return { id, familyId, accountId, presented: formatRefreshToken(id, secret), expiresAt };
  }
}
