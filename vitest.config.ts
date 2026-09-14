import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Everything the package ships: the barrel plus the generated codecs the
      // round-trip tests drive. Measuring only hand-written code would report
      // a near-vacuous 100% over a file of re-exports.
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
