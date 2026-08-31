import { HttpException } from '@nestjs/common';

/**
 * RFC 9457 Problem Details, matching apps/ebpco-api.
 *
 * A public portal's 404 is a normal event — a citizen following a stale link —
 * so it says which slug was not found and nothing about the query that looked
 * for it.
 */
export class ProblemException extends HttpException {
  constructor(status: number, type: string, title: string, detail: string) {
    super({ type: `https://castilla-ebpco.online/problems/${type}`, title, status, detail }, status);
  }

  static notFound(what: string, slug: string): ProblemException {
    return new ProblemException(404, 'not-found', `${what} not found`,
      `No ${what.toLowerCase()} is published with the slug '${slug}'.`);
  }

  /**
   * One message for every sign-in failure.
   *
   * A wrong password, an unknown address, a disabled account and a locked one
   * all produce this. Any difference between them enumerates the LGU's staff.
   */
  static unauthorised(): ProblemException {
    return new ProblemException(401, 'invalid-credentials', 'Sign-in failed',
      'That email address and password combination was not accepted.');
  }

  static forbidden(detail: string): ProblemException {
    return new ProblemException(403, 'forbidden', 'Not permitted', detail);
  }

  static conflict(detail: string): ProblemException {
    return new ProblemException(409, 'conflict', 'Refused', detail);
  }

  static badRequest(detail: string): ProblemException {
    return new ProblemException(400, 'invalid-request', 'Invalid request', detail);
  }
}
