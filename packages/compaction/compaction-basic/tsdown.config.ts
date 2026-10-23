import { defineConfig } from 'tsdown'

/**
 * Build the plugin entry and the dependency-free durable-facts grammar as the
 * two published subpaths. tsc emits them under `lib/types/`; tsdown re-emits
 * each entry as a self-contained file admitted by the package whitelist.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/durable-facts.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
])
