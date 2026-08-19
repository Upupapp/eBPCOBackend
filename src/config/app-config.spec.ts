import { ConfigurationError, loadConfig } from './app-config';

/** The smallest environment that is actually valid, used as a base to perturb. */
const validEnv = (): NodeJS.ProcessEnv => ({
  EBPCO_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgres://ebpco@db.internal:5432/ebpco',
  OBJECT_STORE_ENDPOINT: 'https://objects.internal',
  OBJECT_STORE_BUCKET: 'ebpco-documents',
  MALWARE_SCANNER_URL: 'http://scanner.internal:3310',
  JWT_SIGNING_KEY: 'a-test-signing-key-of-at-least-32-chars',
  PASSWORD_PEPPER: 'a-test-pepper-of-at-least-32-characters',
});

describe('configuration', () => {
  it('accepts a complete environment and freezes the result', () => {
    const config = loadConfig(validEnv());

    expect(config.EBPCO_ENVIRONMENT).toBe('staging');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('refuses to start when a backing service is unconfigured', () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  it('provides no default for any backing service', () => {
    // The point of the check: a default database URL is a service that starts
    // successfully while talking to the wrong thing.
    for (const key of ['DATABASE_URL', 'OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_BUCKET', 'MALWARE_SCANNER_URL']) {
      const env = validEnv();
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigurationError);
    }
  });

  it('reports every problem at once, not the first', () => {
    // An operator bringing up a new environment should learn everything that is
    // missing in one run, not one restart at a time.
    const env = validEnv();
    delete env.DATABASE_URL;
    delete env.OBJECT_STORE_BUCKET;
    delete env.MALWARE_SCANNER_URL;

    try {
      loadConfig(env);
      fail('expected configuration to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues).toHaveLength(3);
    }
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ ...validEnv(), EBPCO_ENVIRONMENT: 'prod' })).toThrow(ConfigurationError);
  });

  it('refuses to publish the contract from a production host', () => {
    // Serving live documentation in production publishes the shape of every
    // endpoint, including the ones a caller is not authorised to reach.
    const env = { ...validEnv(), EBPCO_ENVIRONMENT: 'production', DOCS_ENABLED: 'true' };

    expect(() => loadConfig(env)).toThrow(/DOCS_ENABLED/);
  });

  it('allows the contract to be served outside production', () => {
    const config = loadConfig({ ...validEnv(), EBPCO_ENVIRONMENT: 'staging', DOCS_ENABLED: 'true' });

    expect(config.DOCS_ENABLED).toBe(true);
  });

  it('defaults docs to off when the variable is absent', () => {
    expect(loadConfig(validEnv()).DOCS_ENABLED).toBe(false);
  });

  it('bounds the request budget rather than trusting the value', () => {
    expect(() => loadConfig({ ...validEnv(), REQUEST_TIMEOUT_MS: '0' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnv(), REQUEST_TIMEOUT_MS: '999999' })).toThrow(ConfigurationError);
    expect(loadConfig({ ...validEnv(), REQUEST_TIMEOUT_MS: '5000' }).REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it('rejects a non-numeric integer rather than coercing it to NaN', () => {
    expect(() => loadConfig({ ...validEnv(), PORT: 'eighty' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnv(), BODY_LIMIT_BYTES: '1.5' })).toThrow(ConfigurationError);
  });

  it('always yields a concrete body limit, never undefined', () => {
    // Under exactOptionalPropertyTypes an undefined limit would type-check and
    // then mean "no limit" at runtime.
    expect(typeof loadConfig(validEnv()).BODY_LIMIT_BYTES).toBe('number');
    expect(loadConfig(validEnv()).BODY_LIMIT_BYTES).toBeGreaterThan(0);
  });

  it('does not trust forwarding headers unless told to', () => {
    // Trusting X-Forwarded-For without a proxy in front lets a caller forge
    // their own source address and walk around per-source rate limiting.
    expect(loadConfig(validEnv()).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('rejects a boolean that is not exactly true or false', () => {
    expect(() => loadConfig({ ...validEnv(), TRUST_PROXY: 'yes' })).toThrow(ConfigurationError);
  });
});
