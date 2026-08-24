/** @type {import('jest').Config} */
/**
 * Bounded workers, deliberately.
 *
 * Almost every suite here spins up PGlite — real PostgreSQL compiled to
 * WebAssembly, in-process — and each instance carries its own memory. Jest's
 * default of one worker per core ran fifty-two of those in parallel and the
 * whole run was OOM-killed on a developer machine, which is the worst failure
 * mode a gate can have: it looks like a crash rather than a result, and the
 * next person runs it less often.
 *
 * Two is slower and finishes.
 */
module.exports = {
  maxWorkers: 2,
  // A worker that has grown past this is recycled between suites rather than
  // carrying a leaked PGlite instance into the next one.
  workerIdleMemoryLimit: '1GB',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  // A test that leaks a listening server makes the next test flaky rather than
  // failing honestly. Fail loudly instead.
  detectOpenHandles: true,
  forceExit: false,
};
