import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { currentCorrelationId } from '../correlation/correlation';
import { StructuredLogger } from '../logging/logger';
import {
  describeStatus,
  PROBLEM_CONTENT_TYPE,
  ProblemBody,
  ProblemException,
  ProblemType,
} from './problem';

/**
 * Compared as a plain number, not as HttpStatus: `status` here is an arbitrary
 * integer that may have come from a Fastify plugin rather than from Nest's
 * enum, and comparing the two types is exactly the mismatch the linter flags.
 */
const SERVER_ERROR_FLOOR = 500;

/** Whether a thrown value already carries a Problem Details body. */
function isProblemShaped(value: unknown): value is ProblemBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProblemBody).type === 'string' &&
    typeof (value as ProblemBody).title === 'string'
  );
}

/**
 * Turns every failure into the one error shape the contract defines.
 *
 * Two rules it exists to hold:
 *
 * A 5xx never carries `detail`. An unexpected exception's message routinely
 * contains a query fragment, a file path, or a row of applicant data, and a
 * client is the last place any of that belongs. The message is logged with the
 * correlation id instead, so an operator can find it in seconds while the
 * caller learns only that the request failed.
 *
 * Every response carries the correlation id, including the ones nobody
 * expected. An applicant reporting "it said something went wrong" is
 * unactionable; the same report with an id is a single log query.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const correlationId = currentCorrelationId();

    const status = this.statusOf(exception);
    const body = this.bodyOf(exception, status, request.url, correlationId);

    if (status >= SERVER_ERROR_FLOOR) {
      // The full exception goes to the log, never to the caller.
      this.logger.error('request failed', {
        status,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        error: exception instanceof Error ? exception : { message: String(exception) },
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else {
      this.logger.info('request rejected', {
        status,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        problemType: body.type,
      });
    }

    void reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(body);
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    // Fastify plugins (rate limiting, body limits, content negotiation) throw
    // plain errors that already carry the status they mean. Reporting those as
    // 500 would turn a correct "too many requests" into a fabricated server
    // fault, and would hide a real 5xx among them.
    const status = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 599) return status;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private bodyOf(
    exception: unknown,
    status: number,
    instance: string,
    correlationId: string | undefined,
  ): ProblemBody {
    const base = describeStatus(status);

    // A plugin that already produced a Problem Details body -- the rate
    // limiter does -- has said everything worth saying. Re-deriving it here
    // would drop the detail it computed, such as how long to wait.
    if (isProblemShaped(exception)) {
      return {
        ...exception,
        status,
        instance,
        ...(correlationId === undefined ? {} : { correlationId }),
      };
    }

    if (exception instanceof ProblemException) {
      return {
        type: exception.problemType,
        title: exception.title,
        status,
        ...(exception.detail === undefined ? {} : { detail: exception.detail }),
        instance,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(exception.fieldErrors === undefined ? {} : { errors: exception.fieldErrors }),
      };
    }

    // A 5xx says nothing beyond the fact of failure.
    if (status >= SERVER_ERROR_FLOOR) {
      return {
        type: ProblemType.internal,
        title: 'The request could not be completed',
        status,
        instance,
        ...(correlationId === undefined ? {} : { correlationId }),
      };
    }

    // Hoisted: calling safeDetail twice would not narrow, and would also run
    // the extraction twice for one response.
    const detail = this.safeDetail(exception);
    return {
      type: base.type,
      title: base.title,
      status,
      ...(detail === undefined ? {} : { detail }),
      instance,
      ...(correlationId === undefined ? {} : { correlationId }),
    };
  }

  /** A 4xx may explain itself, but only from a message the framework produced. */
  private safeDetail(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      // `in` has already narrowed the type; asserting again would be noise.
      const { message } = response;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String).join('; ');
    }
    return undefined;
  }
}
