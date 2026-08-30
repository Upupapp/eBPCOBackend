/**
 * PGlite is real PostgreSQL in-process, so the schema tests exercise the actual
 * constraints rather than a stand-in written to agree with them. That matters
 * more here than usual: TAB 01's central requirement is that a confirmed value
 * with no provenance is refused BY THE DATABASE, and a test against a fake
 * would assert the fake.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // A schema test builds a database per file; the default 5s is not enough.
  testTimeout: 30000,
};
