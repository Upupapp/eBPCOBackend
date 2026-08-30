import { AuditService } from '../../compliance/application/audit.service';
import { refusedAuthorisation } from '../../compliance/domain/security-events';
import { AccessTokenClaims } from '../domain/tokens';

/**
 * Records a refused authorisation, bounded, and never at the cost of the refusal.
 *
 * Sits between the guard and the audit service so the guard keeps one job. The
 * two rules it enforces are the ones that make auditing this path safe at all:
 *
 * BOUNDED — at most one entry per account per window, because every audit
 * append serialises on the chain head and an unbounded write here is a denial
 * of service against the audit chain reachable by any ordinary applicant.
 *
 * NEVER FATAL — a failure to record a refusal must not turn a 403 into a 500.
 * The refusal is the security control; the entry is the account of it. Losing
 * the account of it is the smaller harm, and it is surfaced rather than
 * swallowed.
 */
export const REFUSAL_WINDOW_SECONDS = 300;

export class RefusalRecorder {
  constructor(
    private readonly audit: AuditService,
    private readonly onFailure: (cause: unknown) => void = () => undefined,
    private readonly windowSeconds: number = REFUSAL_WINDOW_SECONDS,
  ) {}

  async refused(claims: AccessTokenClaims, path: string, reason: string): Promise<void> {
    try {
      await this.audit.appendOncePerWindow(
        refusedAuthorisation({
          accountId: claims.sub, kind: claims.kind, path, reason,
          windowSeconds: this.windowSeconds,
        }),
        this.windowSeconds,
      );
    } catch (cause) {
      this.onFailure(cause);
    }
  }
}
