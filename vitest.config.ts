import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
        'packages/core/src/**': { lines: 90 },
        'packages/security/src/**': { lines: 90 },
      },
    },
  },
});
