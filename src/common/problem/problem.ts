import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * RFC 9457 Problem Details, as the contract defines them.
 *
 * `type` is a stable, machine-readable identifier a client branches on. It is
 * deliberately not a URL that resolves anywhere: a client must never need a
 * network round trip to understand an error, and a documentation host that
 * moves must not change the meaning of a response.
 */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly errors?: readonly FieldError[];
}

export interface FieldError {
  /** JSON Pointer into the request body. */
  readonly pointer: string;
  readonly message: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The catalog of problem types this service can return.
 *
 * Closed, and named here rather than typed inline at each throw site, so the
 * set a client must handle is enumerable and adding to it is a visible change.
 */
export const ProblemType = {
  badRequest: '/problems/bad-request',
  validationFailed: '/problems/validation-failed',
  unauthorized: '/problems/unauthorized',
  forbidden: '/problems/forbidden',
  notFound: '/problems/not-found',
  conflict: '/problems/conflict',
  preconditionFailed: '/problems/precondition-failed',
  unprocessable: '/problems/unprocessable-entity',
  payloadTooLarge: '/problems/payload-too-large',
  unsupportedMediaType: '/problems/unsupported-media-type',
  tooManyRequests: '/problems/too-many-requests',
  internal: '/problems/internal-error',
  serviceUnavailable: '/problems/service-unavailable',
} as const;

export type ProblemTypeValue = (typeof ProblemType)[keyof typeof ProblemType];

/** Default mapping from status code to problem type and title. */
const BY_STATUS: Partial<Record<number, { type: ProblemTypeValue; title: string }>> = {
  [HttpStatus.BAD_REQUEST]: { type: ProblemType.badRequest, title: 'The request was malformed' },
  [HttpStatus.UNAUTHORIZED]: { type: ProblemType.unauthorized, title: 'Authentication is required' },
  [HttpStatus.FORBIDDEN]: { type: ProblemType.forbidden, title: 'Not permitted' },
  [HttpStatus.NOT_FOUND]: { type: ProblemType.notFound, title: 'No such resource' },
  [HttpStatus.CONFLICT]: { type: ProblemType.conflict, title: 'The resource is not in a state that permits this' },
  [HttpStatus.PRECONDITION_FAILED]: { type: ProblemType.preconditionFailed, title: 'The resource has changed' },
  [HttpStatus.PAYLOAD_TOO_LARGE]: { type: ProblemType.payloadTooLarge, title: 'The payload is too large' },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: { type: ProblemType.unsupportedMediaType, title: 'Unsupported content type' },
  [HttpStatus.UNPROCESSABLE_ENTITY]: { type: ProblemType.unprocessable, title: 'A precondition is unmet' },
  [HttpStatus.TOO_MANY_REQUESTS]: { type: ProblemType.tooManyRequests, title: 'Too many requests' },
  [HttpStatus.SERVICE_UNAVAILABLE]: { type: ProblemType.serviceUnavailable, title: 'A dependency is unavailable' },
};

export function describeStatus(status: number): { type: string; title: string } {
  return BY_STATUS[status] ?? { type: ProblemType.internal, title: 'The request could not be completed' };
}

/**
 * An error that already knows how it should look on the wire.
 *
 * Throwing this rather than a bare HttpException is what lets a domain rule
 * name the specific problem it hit -- "order-of-payment-required" rather than
 * an anonymous 422 the client has to guess at.
 */
export class ProblemException extends HttpException {
  constructor(
    readonly problemType: string,
    readonly title: string,
    status: number,
    readonly detail?: string,
    readonly fieldErrors?: readonly FieldError[],
  ) {
    super(title, status);
  }

  static notFound(detail?: string): ProblemException {
    return new ProblemException(ProblemType.notFound, 'No such resource', HttpStatus.NOT_FOUND, detail);
  }

  static unprocessable(type: string, title: string, detail?: string): ProblemException {
    return new ProblemException(type, title, HttpStatus.UNPROCESSABLE_ENTITY, detail);
  }

  static validation(errors: readonly FieldError[]): ProblemException {
    return new ProblemException(
      ProblemType.validationFailed,
      'The request did not validate',
      HttpStatus.BAD_REQUEST,
      undefined,
      errors,
    );
  }
}
