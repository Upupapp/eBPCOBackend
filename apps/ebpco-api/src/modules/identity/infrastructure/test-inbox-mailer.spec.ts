import { Mailer, OutboundEmail } from './mailer';
import { TestInboxMailer, isReservedTestAddress } from './test-inbox-mailer';

class Recording implements Mailer {
  readonly real = true;
  readonly sent: OutboundEmail[] = [];
  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
  }
}

describe('TestInboxMailer', () => {
  it('delivers mail for a .test address to the test inbox, saying who it was for', async () => {
    const inner = new Recording();
    await new TestInboxMailer(inner, 'owner@lgu.gov.ph').send({
      to: 'jose.rivera@castilla.test', subject: 'Reset your password', text: 'Open this link.', html: '<p>Open</p>',
    });

    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0]!.to).toBe('owner@lgu.gov.ph');
    expect(inner.sent[0]!.subject).toBe('[for jose.rivera@castilla.test] Reset your password');
    expect(inner.sent[0]!.text).toContain('addressed to jose.rivera@castilla.test');
    expect(inner.sent[0]!.text).toContain('Open this link.');
    expect(inner.sent[0]!.html).toContain('<p>Open</p>');
  });

  it('never redirects a real address', async () => {
    // The point of the reserved domain: only mail that could reach nobody moves.
    const inner = new Recording();
    const mailer = new TestInboxMailer(inner, 'owner@lgu.gov.ph');
    for (const to of ['officer@castilla.gov.ph', 'someone@test.com', 'maria@contest.ph', 'firesafety@gmail.com']) {
      await mailer.send({ to, subject: 's', text: 't' });
    }

    expect(inner.sent.map((m) => m.to)).toEqual([
      'officer@castilla.gov.ph', 'someone@test.com', 'maria@contest.ph', 'firesafety@gmail.com',
    ]);
  });

  it('recognises the reserved domain and nothing that merely resembles it', () => {
    expect(isReservedTestAddress('a@castilla.test')).toBe(true);
    expect(isReservedTestAddress('a@TEST')).toBe(true);
    expect(isReservedTestAddress('a@test.com')).toBe(false);
    expect(isReservedTestAddress('a@latest')).toBe(false);
    expect(isReservedTestAddress('not-an-address.test')).toBe(false);
  });

  it('reports whether the wrapped mailer really delivers', () => {
    expect(new TestInboxMailer(new Recording(), 'x@y.ph').real).toBe(true);
  });
});
