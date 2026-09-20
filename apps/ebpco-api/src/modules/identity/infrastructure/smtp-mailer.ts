import { createTransport, Transporter } from 'nodemailer';

import { Mailer, OutboundEmail } from './mailer';

export interface SmtpMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

/**
 * A real send, over SMTP.
 *
 * One transport per process, built once at boot from validated config — not
 * per call, which would reopen a connection for every password-reset request.
 */
export class SmtpMailer implements Mailer {
  readonly real = true;

  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: SmtpMailerOptions) {
    this.from = options.from;
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: { user: options.user, pass: options.pass },
    });
  }

  async send(message: OutboundEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
