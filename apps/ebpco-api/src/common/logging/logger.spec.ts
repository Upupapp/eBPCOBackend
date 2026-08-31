import { runWithCorrelationId } from '../correlation/correlation';
import { REDACTED, StructuredLogger, redact } from './logger';

/** Collects written lines so a test can assert on what would have been logged. */
function capture() {
  const lines: string[] = [];
  const logger = new StructuredLogger('trace', (line) => lines.push(line), () => new Date('2026-08-19T12:00:00Z'));
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('structured logger', () => {
  it('writes one JSON object per line', () => {
    const { logger, parsed } = capture();
    logger.info('listening', { port: 3000 });

    expect(parsed()).toEqual([
      { level: 'info', time: '2026-08-19T12:00:00.000Z', message: 'listening', port: 3000 },
    ]);
  });

  it('filters below the configured level', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger('warn', (line) => lines.push(line));

    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('carries the correlation id of the request it is serving', () => {
    const { logger, parsed } = capture();
    runWithCorrelationId('abc-123', () => logger.info('inside a request'));

    expect(parsed()[0]?.correlationId).toBe('abc-123');
  });

  it('omits the correlation id outside a request', () => {
    const { logger, parsed } = capture();
    logger.info('at boot');

    expect(parsed()[0]).not.toHaveProperty('correlationId');
  });
});

describe('redaction', () => {
  // The control that matters: a log aggregator holding applicant names and
  // mobile numbers is a second, unregistered copy of the personal data the
  // database holds, with none of its access controls.

  it.each([
    'password', 'passwd', 'secret', 'token', 'refreshToken', 'accessToken',
    'authorization', 'cookie', 'apiKey', 'api_key', 'privateKey',
    'credential', 'verifier', 'salt', 'pepper',
  ])('never writes a credential field: %s', (key) => {
    expect(redact({ [key]: 'sensitive-value' })).toEqual({ [key]: REDACTED });
  });

  it.each([
    'email', 'applicantEmail', 'mobileNumber', 'phone', 'firstName', 'lastName',
    'fullName', 'applicant', 'address', 'street', 'barangay', 'dateOfBirth',
    'tin', 'philsysNumber', 'pushToken',
  ])('never writes personal data: %s', (key) => {
    expect(redact({ [key]: 'Maria Santos' })).toEqual({ [key]: REDACTED });
  });

  it('matches on substrings and ignores case', () => {
    expect(redact({ APPLICANT_EMAIL: 'x', userPassword: 'y', Mobile: 'z' })).toEqual({
      APPLICANT_EMAIL: REDACTED,
      userPassword: REDACTED,
      Mobile: REDACTED,
    });
  });

  it('redacts inside nested objects and arrays', () => {
    expect(
      redact({ request: { body: { applicants: [{ email: 'a@b.ph', businessId: 'keep' }] } } }),
    ).toEqual({ request: { body: { applicants: REDACTED } } });
  });

  it('keeps fields that carry no personal data', () => {
    expect(redact({ status: 422, route: '/applications/:id', durationMs: 12, permitType: 'Fencing Permit' })).toEqual({
      status: 422,
      route: '/applications/:id',
      durationMs: 12,
      permitType: 'Fencing Permit',
    });
  });

  it('reduces an Error to name and message, dropping the stack', () => {
    const error = new Error('boom');
    expect(redact({ error })).toEqual({ error: { name: 'Error', message: 'boom' } });
  });

  it('truncates rather than following an unbounded structure', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i += 1) {
      const child: Record<string, unknown> = {};
      node.child = child;
      node = child;
    }

    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('survives a cycle without recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });

  it('caps a long array rather than writing every element', () => {
    const written = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as { items: unknown[] };
    expect(written.items).toHaveLength(50);
  });

  it('redacts through the logger, not only through the helper', () => {
    const { logger, lines } = capture();
    logger.info('sign-in attempt', { email: 'maria.santos@example.ph', password: 'hunter2', outcome: 'rejected' });

    expect(lines[0]).not.toContain('maria.santos@example.ph');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).toContain('rejected');
  });
});
