#!/usr/bin/env node
/**
 * Normalize relative module specifiers in emitted declarations for Node ESM.
 *
 * TypeScript preserves the source spelling of relative imports. The whiteboard
 * source uses extensionless local imports (the esbuild bundle resolves them),
 * but a `.d.ts` consumed under NodeNext needs the emitted `.js` specifier so
 * TypeScript maps it back to the sibling declaration. This step only rewrites
 * a specifier when the corresponding `lib/**` declaration exists, so external
 * package imports and already-extended paths are untouched.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const declarationRoot = join(packageRoot, 'lib')

function declarationFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...declarationFiles(path))
    else if (entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

function rewrite(file) {
  const source = readFileSync(file, 'utf8')
  const next = source.replace(
    /((?:\bfrom\s+|\bimport\s*\(\s*)['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (match, prefix, specifier, suffix) => {
      if (extname(specifier) !== '') return match
      const target = resolve(dirname(file), `${specifier}.d.ts`)
      return existsSync(target) ? `${prefix}${specifier}.js${suffix}` : match
    },
  )
  if (next !== source) writeFileSync(file, next)
}

for (const file of declarationFiles(declarationRoot)) rewrite(file)
