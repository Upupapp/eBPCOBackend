import { ContactsController } from './contacts.controller';
import { ContactVerificationService } from '../application/contact-verification.service';
import { ContactVerificationMailer } from '../application/contact-verification-mailer';
import { StructuredLogger } from '../../../common/logging/logger';
import type { AuthenticatedRequest } from './guards/authentication.guard';

/**
 * `POST /me/contacts/:channel/request` — the honesty of "was this actually
 * sent" is the whole point of this controller (see its own module doc
 * comment), and the three-way branch (sent / failed / not-sent) is easy to
 * get backwards without a real mailer or database to catch it — this tests
 * the branch directly, against fakes, rather than needing a real SMTP
 * server or a live PGlite instance just to prove which message wins.
 */
describe('ContactsController — honesty about whether a code actually went out', () => {
  const authenticatedRequest = { caller: { sub: 'acc-1' } } as unknown as AuthenticatedRequest;

  const state = { channel: 'email' as const, value: 'maria@example.ph', status: 'Pending Verification' as const,
    method: null, verifiedAt: null, lastRequestedAt: null };

  function controllerWith(options: {
    real: boolean;
    sendCode?: () => Promise<void>;
  }) {
    const contacts = {
      request: () => Promise.resolve({ ok: true as const, state, code: '482913' }),
    } as unknown as ContactVerificationService;

    const sendCode = options.sendCode ?? (() => Promise.resolve());
    const mailer = {
      real: options.real,
      sendCode,
    } as unknown as ContactVerificationMailer;

    const logged: string[] = [];
    const logger = new StructuredLogger('error', (line) => logged.push(line));

    return { controller: new ContactsController(contacts, mailer, logger), logged };
  }

  it('sends for real and says so, once MAIL_DRIVER=smtp (mailer.real is true)', async () => {
    let calledWith: [string, string] | null = null;
    const { controller } = controllerWith({
      real: true,
      sendCode: () => {
        calledWith = ['maria@example.ph', '482913'];
        return Promise.resolve();
      },
    });

    const result = await controller.request(authenticatedRequest, 'email') as {
      delivery: string; detail: string;
    };

    expect(calledWith).toEqual(['maria@example.ph', '482913']);
    expect(result.delivery).toBe('sent');
    expect(result.detail).toMatch(/6-digit code was sent/i);
  });

  it('reports FAILED, not silently NOT-SENT, when a real mailer throws', async () => {
    const { controller, logged } = controllerWith({
      real: true,
      sendCode: () => Promise.reject(new Error('SMTP connection refused')),
    });

    const result = await controller.request(authenticatedRequest, 'email') as {
      delivery: string; detail: string;
    };

    // "recorded, not delivered, no provider configured" would be a LIE here —
    // a provider is configured and it just failed. A different message earns
    // a different reason to distrust it.
    expect(result.delivery).toBe('failed');
    expect(result.detail).not.toMatch(/no message provider/i);
    expect(result.detail).toMatch(/could not be sent/i);
    expect(logged.some((line) => line.includes('SMTP connection refused'))).toBe(true);
  });

  it('still answers NOT-SENT for email while no provider is configured (mailer.real is false)', async () => {
    let called = false;
    const { controller } = controllerWith({
      real: false,
      sendCode: () => { called = true; return Promise.resolve(); },
    });

    const result = await controller.request(authenticatedRequest, 'email') as {
      delivery: string; detail: string;
    };

    expect(called).toBe(false);
    expect(result.delivery).toBe('not-sent');
    expect(result.detail).toMatch(/no message provider/i);
  });

  it('never attempts to send for the mobile channel, real mailer or not — there is no SMS provider', async () => {
    let called = false;
    const { controller } = controllerWith({
      real: true,
      sendCode: () => { called = true; return Promise.resolve(); },
    });

    const result = await controller.request(authenticatedRequest, 'mobile') as {
      delivery: string; detail: string;
    };

    expect(called).toBe(false);
    expect(result.delivery).toBe('not-sent');
    expect(result.detail).toMatch(/cannot send SMS/i);
  });
});
