/** Opt-in source-plane acceptance drill: `vitest run --config scripts/worker-drill.vitest.config.ts`.
 * Use an isolated home with `DSH_WIRE_*` unset. Failures exit nonzero; declared limits do not.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

const gatewayRequire = createRequire(new URL('../packages/api/gateway/package.json', import.meta.url))
export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  resolve: { alias: { ws: gatewayRequire.resolve('ws') } },
  test: { include: ['scripts/worker-drill.e2e.ts'], environment: 'node', fileParallelism: false },
})
