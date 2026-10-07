module.exports = {
  testEnvironment: 'node',
  // Pure-logic suites only: voice/robot/eyes/ai(service) import native
  // modules that don't exist under Jest. Keep scoped to logic tests.
  roots: ['<rootDir>/src/intent', '<rootDir>/src/ai'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  verbose: true,
};
