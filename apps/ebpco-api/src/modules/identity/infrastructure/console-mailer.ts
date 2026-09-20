import { StructuredLogger } from '../../../common/logging/logger';
import { Mailer, OutboundEmail } from './mailer';

/**
 * The development fallback: nothing is delivered, everything is printed.
 *
 * `StructuredLogger` redacts any FIELD whose key looks like `email` or
 * `token` before it is written (see `common/logging/logger.ts`) — a real
 * property everywhere else in this service, and exactly wrong here, where the
 * whole point is to be able to read the link a real send would have delivered.
 * Built as one interpolated `message` string rather than structured `fields`
 * for that reason: the redaction only inspects `fields`.
 */
export class ConsoleMailer implements Mailer {
  readonly real = false;

  constructor(private readonly logger: StructuredLogger) {}

  send(message: OutboundEmail): Promise<void> {
    this.logger.info(
      `[ConsoleMailer] No SMTP configured (MAIL_DRIVER=console) — this email was not sent, only logged.\n`
      + `  To:      ${message.to}\n`
      + `  Subject: ${message.subject}\n`
      + `  ---\n`
      + `${message.text}\n`
      + `  ---`,
    );
    return Promise.resolve();
  }
}
