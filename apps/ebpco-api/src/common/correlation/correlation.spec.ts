import {
  currentCorrelationId,
  newCorrelationId,
  runWithCorrelationId,
  sanitiseCorrelationId,
} from './correlation';

describe('correlation id', () => {
  it('is undefined outside a request', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('is visible to everything running inside the request', () => {
    runWithCorrelationId('req-1', () => {
      expect(currentCorrelationId()).toBe('req-1');
    });
  });

  it('survives an await boundary', async () => {
    await runWithCorrelationId('req-2', async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe('req-2');
    });
  });

  it('does not leak between concurrent requests', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithCorrelationId('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(currentCorrelationId() ?? 'none');
      }),
      runWithCorrelationId('b', () => {
        seen.push(currentCorrelationId() ?? 'none');
        return Promise.resolve();
      }),
    ]);

    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('generates a distinct id each time', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe('accepting a caller-supplied correlation id', () => {
  it('accepts a plausible id', () => {
    expect(sanitiseCorrelationId('01J9F8ZK3QYB7N2M4P6R8T0V2X')).toBe('01J9F8ZK3QYB7N2M4P6R8T0V2X');
    expect(sanitiseCorrelationId('  trimmed-me  ')).toBe('trimmed-me');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a newline, which would forge a second log line', 'abc\ndef'],
    ['a control character', 'abc\u0007def'],
    ['JSON, which would break the log record', '{"level":"fatal"}'],
    ['a space-separated pair', 'abc def'],
    ['a non-string', 12345],
  ])('rejects %s', (_label, candidate) => {
    expect(sanitiseCorrelationId(candidate)).toBeNull();
  });

  it('rejects an over-long id rather than repeating it on every log line', () => {
    expect(sanitiseCorrelationId('x'.repeat(65))).toBeNull();
    expect(sanitiseCorrelationId('x'.repeat(64))).toHaveLength(64);
  });
});
