import { defineConfig } from 'tsdown'

/**
 * Isolated host bundle for the peer API package: emit the loader entry and the
 * caller bridge from the TypeScript project output. Typert strict faces are
 * not generated yet, so the Gateway dispatches this namespace through SRC
 * markers (`@Remote`), which the decorator lowering below must preserve.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/client.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
