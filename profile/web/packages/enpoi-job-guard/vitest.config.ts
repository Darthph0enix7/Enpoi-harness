import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../../../vitest.shared.ts'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin(), tsconfigPaths({
    projects: [fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))],
  })],
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
