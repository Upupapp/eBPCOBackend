import { Mailer, OutboundEmail } from './mailer';

/**
 * Mail for TEST accounts, delivered to one real inbox.
 *
 * The owner's test officers sign in with addresses on `.test` — a top-level
 * domain reserved by RFC 6761 so that it can never belong to anyone, which is
 * exactly why they are safe to hand out: "Forgot password" on a made-up
 * address at a real domain would send a working reset link to whoever owns
 * that address. The cost is that `.test` mail goes nowhere, so a password
 * reset on a test account could never be finished.
 *
 * With `MAIL_TEST_INBOX` set, a message to a `.test` address is delivered to
 * that inbox instead, saying who it was for. Every other address is untouched:
 * a real officer's or citizen's mail is never redirected, whatever this is set
 * to.
 */
export class TestInboxMailer implements Mailer {
  constructor(private readonly inner: Mailer, private readonly inbox: string) {}

  get real(): boolean {
    return this.inner.real;
  }

  send(message: OutboundEmail): Promise<void> {
    if (!isReservedTestAddress(message.to)) return this.inner.send(message);
    const note = `This message was addressed to ${message.to}, a test account, and sent here instead.`;
    return this.inner.send({
      to: this.inbox,
      subject: `[for ${message.to}] ${message.subject}`,
      text: `${note}\n\n${message.text}`,
      ...(message.html === undefined ? {} : { html: `<p><em>${escapeHtml(note)}</em></p>${message.html}` }),
    });
  }
}

/** An address on the reserved `.test` top-level domain. */
export function isReservedTestAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && /(^|\.)test$/i.test(address.slice(at + 1).trim());
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
