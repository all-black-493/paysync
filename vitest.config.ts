import { defineConfig } from 'vitest/config'

const integration = '**/src/**/*.int.test.ts'

export default defineConfig({
  cacheDir: '/tmp/vitest',
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/src/**/*.test.ts'],
          exclude: [integration, '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [integration],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
