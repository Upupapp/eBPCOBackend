import { AppConfig } from '../../../config/app-config';
import { StructuredLogger } from '../../../common/logging/logger';
import { ConsoleMailer } from './console-mailer';
import { Mailer } from './mailer';
import { SmtpMailer } from './smtp-mailer';
import { TestInboxMailer } from './test-inbox-mailer';

/**
 * Which mailer the service runs on.
 *
 * Exported and named rather than an inline factory, for the same reason
 * `objectStoreFor`/`malwareScannerFor` are in `documents.module.ts`: a
 * break-check that pointed this branch at the console mailer while the driver
 * said `smtp` would pass the whole suite otherwise.
 */
export function mailerFor(config: AppConfig, logger: StructuredLogger): Mailer {
  const mailer = deliveringMailerFor(config, logger);
  // Mail for reserved `.test` addresses (the owner's test accounts) goes to
  // one real inbox when one is configured; nothing else is ever redirected.
  return config.MAIL_TEST_INBOX === undefined ? mailer : new TestInboxMailer(mailer, config.MAIL_TEST_INBOX);
}

function deliveringMailerFor(config: AppConfig, logger: StructuredLogger): Mailer {
  if (config.MAIL_DRIVER === 'smtp') {
    return new SmtpMailer({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      from: config.MAIL_FROM,
    });
  }

  // `console` is the default everywhere, including production, unlike the
  // object store and the malware scanner: this service can run correctly with
  // no mail sent at all (an officer who never gets the email can still be
  // helped by an administrator over the phone), where a filesystem object
  // store or an unscanned upload cannot. An operator who wants real delivery
  // sets MAIL_DRIVER=smtp and the four SMTP_* variables below; nothing here
  // forces that choice.
  return new ConsoleMailer(logger);
}
