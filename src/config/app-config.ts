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

/** An unfilled environment variable is not a value. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

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

    // Encrypts the TOTP secrets at rest. A SEPARATE key from the signing key,
    // not a derivation of it: rotating a signing key is a routine act, and if
    // the two shared material that rotation would make every officer's second
    // factor undecryptable at once. Optional in development, required outside
    // it, below.
    TOTP_ENCRYPTION_KEY: z.string().optional().transform((v) => v ?? ''),

    // Request handling. Bounded by construction: an unbounded body or an
    // unbounded request lifetime is a denial-of-service surface.
    REQUEST_TIMEOUT_MS: intFromEnv(1_000, 120_000, 20_000),
    BODY_LIMIT_BYTES: intFromEnv(1_024, 52_428_800, 1_048_576),
    RATE_LIMIT_MAX: intFromEnv(1, 100_000, 300),

    // Connection pool. Fixed at 10 in code until now, which is a number that
    // was right for nothing in particular: too many for a small managed
    // Postgres shared by several replicas, too few for one instance under load.
    // It has to be tuned against the deployment, and a value that requires a
    // rebuild to change is a value nobody tunes.
    //
    // The ceiling is deliberately low. `max` is PER PROCESS, and the failure
    // mode is not this service slowing down: it is exhausting the server's
    // global connection limit and taking down every other client of the same
    // database, including whatever an operator is using to diagnose it.
    DB_POOL_MAX: intFromEnv(1, 100, 10),

    // A connection that cannot be obtained quickly is a dependency outage, and
    // a request should fail fast rather than queue behind one -- a queue in
    // front of an unavailable database converts a fast failure into a timeout
    // for every caller at once.
    DB_CONNECTION_TIMEOUT_MS: intFromEnv(100, 60_000, 5_000),

    // A query that has not returned in this long is not going to. Enforced by
    // the server, so it applies even if this process stops waiting.
    DB_STATEMENT_TIMEOUT_MS: intFromEnv(1_000, 300_000, 30_000),

    // Where the FILESYSTEM object store writes, which is not the same thing as
    // OBJECT_STORE_ENDPOINT — that is the S3 adapter's setting. Passing the
    // endpoint here wrote documents into a directory named after a URL, under
    // whatever the process working directory happened to be.
    //
    // Development and tests only. A deployment with more than one replica needs
    // the S3 adapter, because a filesystem store means documents live on one
    // replica's disk.
    OBJECT_STORE_LOCAL_PATH: z.string().min(1).optional()
      .transform((value) => value ?? '.data/objects'),

    /**
     * Which object store to build. Explicit, not inferred.
     *
     * Inferring it from whether an endpoint is set was the obvious design and
     * is the wrong one: an operator who mistypes the variable name gets the
     * filesystem store, silently, and finds out when documents disappear on the
     * next redeploy. A driver that must be named cannot be chosen by accident.
     */
    OBJECT_STORE_DRIVER: z.enum(['filesystem', 's3']).optional()
      .transform((value) => value ?? 'filesystem'),

    /**
     * The region an S3-compatible endpoint expects.
     *
     * No default. Linode Object Storage, MinIO and AWS all want different
     * values here, and a default would be one of them being right and the rest
     * failing in a way that looks like a credential problem.
     */
    // Empty is treated as UNSET, not as an invalid value. A hosting platform
    // that renders an unfilled variable as "" is common, and refusing to boot
    // over it would report a validation failure for something the operator
    // never set.
    OBJECT_STORE_REGION: z.preprocess(blankToUndefined, z.string().min(1).optional())
      .transform((value) => value ?? ''),

    /**
     * The base URL an ANONYMOUS request would use to reach the bucket, for the
     * public-readability probe. Usually the same as OBJECT_STORE_ENDPOINT.
     *
     * Separate because they are not always the same thing: a service reaching
     * storage over a private network has an endpoint no stranger can use, and
     * probing that one would prove nothing about what the internet can see.
     */
    OBJECT_STORE_PUBLIC_PROBE_URL: z.preprocess(blankToUndefined, z.string().url().optional())
      .transform((value) => value ?? ''),

    // How long an access token lives, in seconds.
    //
    // The 900-second ceiling is a security property and is enforced in
    // TokenService, not here: it bounds how long a session that has been signed
    // out could keep working if the revocation record were ever lost. The
    // default sits AT that ceiling deliberately, and the reason is a
    // measurement nobody has taken.
    //
    // The mobile client refreshes REACTIVELY — it discovers expiry by getting a
    // 401 and then refreshes and retries. Halving this does not halve a risk
    // window and then stop; it triples the round trips on exactly the
    // connections the offline queue exists for, and an applicant on a rural
    // link pays for that on every screen. Since revocation now works, the
    // stolen-token window is bounded by an explicit sign-out rather than by
    // expiry, which is the stronger of the two mechanisms and the one that
    // improved.
    //
    // Lower it where the trade is worth it — shared kiosk hardware in a city
    // hall, say, where the network is good and the device is not the
    // applicant's. That is a deployment decision, which is why it is here.
    //
    // The floor is 60 seconds. Below that a client can spend more time
    // refreshing than working, and the mobile client's single-flight refresh
    // stops being an optimisation and becomes the critical path.
    ACCESS_TOKEN_TTL_SECONDS: intFromEnv(60, 900, 900),

    // Periodic work. Off by default so a test or a one-off process does not
    // start deleting documents as a side effect of booting; every deployment
    // that should run jobs sets it explicitly.
    SCHEDULER_ENABLED: boolFromEnv(false),

    // Must be well below the shortest job interval, or a job due every minute
    // waits for the next tick instead.
    SCHEDULER_TICK_SECONDS: intFromEnv(1, 3_600, 15),

    // How long documents are kept after their application CLOSES. No default:
    // a retention period invented by this service would be a data-minimisation
    // decision made by the wrong party (M-15). Unset means retention runs and
    // deletes nothing, saying so.
    DOCUMENT_RETENTION_DAYS: z
      .string()
      .regex(/^\d+$/, 'must be a whole number of days')
      .transform(Number)
      .pipe(z.number().int().min(1).max(36_500))
      .optional()
      .transform((value) => value ?? null),

    // How long to keep serving after reporting not-ready, so the load balancer
    // has time to stop sending. Below its own check interval this achieves
    // nothing; the default assumes a 5s interval and two failed checks.
    SHUTDOWN_DRAIN_MS: intFromEnv(0, 120_000, 12_000),

    // How long to wait for in-flight work after that. Must stay under the
    // orchestrator's own termination grace period, or the process is SIGKILLed
    // mid-transaction and the deadline never fires.
    SHUTDOWN_DEADLINE_MS: intFromEnv(1_000, 120_000, 20_000),
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
    if (config.EBPCO_ENVIRONMENT !== 'development' && config.TOTP_ENCRYPTION_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TOTP_ENCRYPTION_KEY'],
        message:
          'required outside development — without it a leaked database yields every officer\'s '
          + 'second factor, which is the one thing standing between a stolen password and an approval',
      });
    }

    if (config.EBPCO_ENVIRONMENT !== 'development' && config.PASSWORD_PEPPER.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_PEPPER'],
        message:
          'required outside development — without it, a leaked database yields directly crackable password verifiers',
      });
    }

    // The filesystem store means documents live on ONE container's disk: lost
    // on the next deploy, invisible to every other replica, and written against
    // a root filesystem the Dockerfile expects to be read-only. That is
    // acceptable in development and in a staging environment somebody has
    // chosen it for. It is not acceptable for citizens' identity documents and
    // land titles, so production refuses to boot rather than accepting them
    // somewhere they will not survive.
    if (config.EBPCO_ENVIRONMENT === 'production' && config.OBJECT_STORE_DRIVER !== 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OBJECT_STORE_DRIVER'],
        message: 'must be "s3" in production — the filesystem store keeps documents on one '
          + "container's disk, where a redeploy destroys them and no other replica can read them",
      });
    }

    if (config.OBJECT_STORE_DRIVER === 's3') {
      // Named individually rather than as one "S3 is misconfigured": an
      // operator reading a crash loop needs the variable, not the subsystem.
      for (const [key, value] of [
        ['OBJECT_STORE_ENDPOINT', config.OBJECT_STORE_ENDPOINT],
        ['OBJECT_STORE_BUCKET', config.OBJECT_STORE_BUCKET],
        ['OBJECT_STORE_REGION', config.OBJECT_STORE_REGION],
      ] as const) {
        if (value.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when OBJECT_STORE_DRIVER is "s3"',
          });
        }
      }
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
