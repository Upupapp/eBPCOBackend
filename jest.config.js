/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  // `.js` as well as `.ts`: `jose` ships ESM only, and the runtime here is
  // CommonJS, so its source has to be transformed rather than required as-is.
  transform: { '^.+\\.[tj]s$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // node_modules is not transformed by default, which is what makes an ESM-only
  // dependency fail with "Unexpected token 'export'". jose is the one exception.
  transformIgnorePatterns: ['/node_modules/(?!jose/)'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  // A test that leaks a listening server makes the next test flaky rather than
  // failing honestly. Fail loudly instead.
  detectOpenHandles: true,
  forceExit: false,
};
