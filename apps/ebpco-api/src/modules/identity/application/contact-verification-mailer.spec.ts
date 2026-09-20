import { ContactVerificationMailer } from './contact-verification-mailer';
import { Mailer, OutboundEmail } from '../infrastructure/mailer';

class RecordingMailer implements Mailer {
  readonly real: boolean;
  sent: OutboundEmail[] = [];

  constructor(real: boolean) {
    this.real = real;
  }

  send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('ContactVerificationMailer', () => {
  it('sends the code to the given address, in both the text and html bodies', async () => {
    const mailer = new RecordingMailer(true);
    const contactMailer = new ContactVerificationMailer(mailer);

    await contactMailer.sendCode('maria@example.ph', '482913');

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe('maria@example.ph');
    expect(message.text).toContain('482913');
    expect(message.html).toContain('482913');
    // Every client must get SOMETHING readable, not just an HTML client —
    // see Mailer.OutboundEmail's own doc comment on why `text` is required.
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('escapes the code in the HTML body, even though it is server-generated digits', async () => {
    // Six digits from randomInt() can never actually contain markup — this
    // guards the escaping discipline itself (the same one
    // account-recovery-mailer.ts's escapeHtml exists for), not a realistic
    // attack on this specific field.
    const mailer = new RecordingMailer(true);
    const contactMailer = new ContactVerificationMailer(mailer);

    await contactMailer.sendCode('maria@example.ph', '<b>1</b>');

    expect(mailer.sent[0]!.html).not.toContain('<b>1</b>');
    expect(mailer.sent[0]!.html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });

  it('exposes the underlying mailer\'s real flag, unchanged', () => {
    expect(new ContactVerificationMailer(new RecordingMailer(true)).real).toBe(true);
    expect(new ContactVerificationMailer(new RecordingMailer(false)).real).toBe(false);
  });
});
