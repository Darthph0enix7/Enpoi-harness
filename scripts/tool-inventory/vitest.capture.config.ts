/** Isolated Vitest config for the keyless tool-inventory capture child. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

const ownedRoot = process.env.DSH_KEYLESS_INVENTORY_ROOT

export default defineConfig({
  ...(ownedRoot === undefined ? {} : { cacheDir: join(ownedRoot, 'vite-cache') }),
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] })],
  resolve: { extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'] },
  test: {
    include: ['scripts/tool-inventory/keyless-inventory-runner.e2e.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
