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
          include: [
            'packages/db/test/**/*.int.test.ts',
            'apps/api/test/**/*.int.test.ts',
            'apps/worker/test/**/*.int.test.ts',
            'apps/admin/test/**/*.int.test.ts',
          ],
          globalSetup: ['packages/db/test/global-setup.ts'],
          // Files share one database; SKIP LOCKED claims in one file must not see another
          // file's row locks, so integration files run one at a time.
          fileParallelism: false,
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
          name: 'e2e',
          include: ['apps/*/test/**/*.e2e.test.ts'],
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
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
