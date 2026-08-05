import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(import.meta.dirname, 'test/mocks/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/vitest.setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
})
