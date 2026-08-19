import { currentCorrelationId } from '../correlation/correlation';

/**
 * Structured logs, as a stream, with personal data and credentials removed
 * before they are written.
 *
 * The redaction is deliberately a property of the logger rather than a review
 * habit. NPC Circular 16-01 expects a government agency to account for where
 * personal data goes; a log aggregator that has accumulated applicant names
 * and mobile numbers is a second, unregistered copy of the personal data the
 * database holds, with none of its access controls. Relying on every future
 * contributor to remember that is not a control.
 *
 * TAB 15 replaces this with OpenTelemetry. The redaction contract stays.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10,
};

/**
 * Keys whose values never appear in a log line, at any level, in any
 * environment. Matched case-insensitively and on substrings, so
 * `applicantEmail` is caught by `email` and `refreshToken` by `token`.
 */
const REDACTED_KEYS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'auth', 'cookie',
  'credential', 'verifier', 'salt', 'pepper', 'apikey', 'api_key', 'privatekey',
  'email', 'mobile', 'phone', 'firstname', 'lastname', 'fullname', 'applicant',
  // 'birth' rather than 'birthdate': `dateOfBirth` lowercases to "dateofbirth",
  // which contains neither 'dob' nor 'birthdate'. A test caught that hole, and
  // the lesson is that this list must match on the shortest distinctive stem.
  'address', 'street', 'barangay', 'dob', 'birth', 'tin', 'philsys',
  'sha256', 'pushtoken',
];

export const REDACTED = '[redacted]';

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEYS.some((needle) => lower.includes(needle));
}

/** Depth cap: a cyclic or very deep object must not become an unbounded log line. */
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedKey(key) ? REDACTED : redact(nested, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export type LogSink = (line: string) => void;

export class StructuredLogger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly sink: LogSink = (line) => process.stdout.write(`${line}\n`),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  fatal(message: string, fields?: Record<string, unknown>): void { this.write('fatal', message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.write('error', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.write('warn', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.write('info', message, fields); }
  debug(message: string, fields?: Record<string, unknown>): void { this.write('debug', message, fields); }
  trace(message: string, fields?: Record<string, unknown>): void { this.write('trace', message, fields); }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const correlationId = currentCorrelationId();
    const record: Record<string, unknown> = {
      level,
      time: this.clock().toISOString(),
      message,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };
    this.sink(JSON.stringify(record));
  }
}
