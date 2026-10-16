import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace packages export `@rp/source` (.ts) for tests/typecheck and `default` (dist) for Node.
  // The condition name is scoped: some npm packages publish a plain `source` condition.
  resolve: { conditions: ['@rp/source'] },
  ssr: { resolve: { conditions: ['@rp/source'] } },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'int',
          include: ['packages/db/test/**/*.int.test.ts', 'apps/api/test/**/*.int.test.ts'],
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'redis-int',
          include: ['apps/api/test/**/*.redis.test.ts'],
        },
      },
      {
        test: {
          name: 'stellar-int',
          include: ['packages/stellar/test/**/*.int.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 240_000,
        },
      },
    ],
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
