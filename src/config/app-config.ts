import { z } from 'zod';

/**
 * Every value that varies between deployments, read from the environment and
 * from nowhere else.
 *
 * Twelve-factor, and for a reason beyond orthodoxy: this service will hold
 * applicant personal data under RA 10173, and a checked-in configuration file
 * is how a staging hostname or a credential reaches a repository. There is no
 * default for any backing service. The application must be able to start with
 * no local file present but its environment set, and must refuse to start at
 * all if something it needs is missing -- a service that boots half-configured
 * fails later, in production, in front of an applicant.
 */

const Environment = z.enum(['development', 'staging', 'production']);
export type Environment = z.infer<typeof Environment>;

/**
 * Coerce a decimal string to a bounded integer, rejecting anything else.
 *
 * The fallback is required rather than optional so the parsed type is `number`
 * and never `number | undefined`. Under `exactOptionalPropertyTypes` that
 * distinction is load-bearing: a maybe-undefined body limit would be accepted
 * by the type checker and then silently mean "no limit" at runtime.
 */
const intFromEnv = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true'));

const schema = z
  .object({
    EBPCO_ENVIRONMENT: Environment,
    PORT: intFromEnv(1, 65535, 3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),

    // Backing services. No defaults, deliberately: a default database URL is a
    // service that silently starts talking to the wrong thing.
    DATABASE_URL: z.string().min(1, 'required — no default is provided for a backing service'),
    OBJECT_STORE_ENDPOINT: z.string().min(1, 'required — no default is provided for a backing service'),
    OBJECT_STORE_BUCKET: z.string().min(1, 'required — no default is provided for a backing service'),
    MALWARE_SCANNER_URL: z.string().min(1, 'required — uploads must not be servable unscanned'),

    // Security-critical, and therefore treated exactly like a backing service:
    // no default. A signing key with a fallback is a signing key that is the
    // same in every deployment that forgot to set one, and anyone who has read
    // the source can then mint a token for any account.
    JWT_SIGNING_KEY: z
      .string()
      .min(32, 'required — at least 32 characters of secret material, from the secret manager'),

    // Mixed into every password verifier and held outside the database, so a
    // database-only leak does not yield crackable verifiers. Optional because
    // development has no secret manager; required outside it, below.
    PASSWORD_PEPPER: z.string().optional().transform((v) => v ?? ''),

    // Request handling. Bounded by construction: an unbounded body or an
    // unbounded request lifetime is a denial-of-service surface.
    REQUEST_TIMEOUT_MS: intFromEnv(1_000, 120_000, 20_000),
    BODY_LIMIT_BYTES: intFromEnv(1_024, 52_428_800, 1_048_576),
    RATE_LIMIT_MAX: intFromEnv(1, 100_000, 300),
    RATE_LIMIT_WINDOW_MS: intFromEnv(1_000, 3_600_000, 60_000),

    // True only behind a proxy that is known to set X-Forwarded-For, because
    // trusting that header without one lets a caller forge their own source
    // address and defeat per-source rate limiting.
    TRUST_PROXY: boolFromEnv(false),

    // The contract this build implements, surfaced at /version so a bug report
    // names a contract as well as a build.
    CONTRACT_VERSION: z.string().min(1).optional().transform((v) => v ?? '0.1.0'),
    BUILD_COMMIT: z.string().min(1).optional().transform((v) => v ?? 'unknown'),
    BUILD_TIME: z.string().min(1).optional(),

    DOCS_ENABLED: boolFromEnv(false),
  })
  .superRefine((config, ctx) => {
    // An invariant, not a preference. Serving the contract as live documentation
    // in production publishes the shape of every endpoint, including the ones a
    // caller is not authorised to reach, to anyone who asks.
    if (config.EBPCO_ENVIRONMENT !== 'development' && config.PASSWORD_PEPPER.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_PEPPER'],
        message:
          'required outside development — without it, a leaked database yields directly crackable password verifiers',
      });
    }

    if (config.EBPCO_ENVIRONMENT === 'production' && config.DOCS_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DOCS_ENABLED'],
        message: 'must be false in production — the contract is not published from a production host',
      });
    }
  });

export type AppConfig = Readonly<z.infer<typeof schema>>;

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `refusing to start: ${issues.length} configuration problem(s)\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'ConfigurationError';
  }
}

/**
 * Validate the environment once, at boot.
 *
 * Reports every problem at once rather than the first: an operator bringing up
 * a new environment should learn everything that is missing in one run, not
 * discover it one restart at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return Object.freeze(result.data);
}

export const CONFIG = Symbol('EBPCO_CONFIG');
