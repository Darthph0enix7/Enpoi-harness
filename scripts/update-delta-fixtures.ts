/**
 * Shared fixtures for the update-delta specs: the engine bundle used by the
 * plain-JS apply module, hashing/tar helpers, and deterministic release-asset
 * builders. Kept out of the spec files so both the unit suite and the
 * scratch-prefix E2E build the same artifacts.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Repository root (the parent of this file's directory). */
export const repoRoot = join(import.meta.dirname, '..')

/** sha256 of a buffer as lowercase hex. */
export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Write the sha256sum-format sidecar next to a file. */
export function writeSha256Sidecar(file: string): string {
  const digest = sha256Hex(readFileSync(file))
  writeFileSync(`${file}.sha256`, `${digest}  ${basename(file)}\n`)
  return digest
}

/**
 * Bundle packages/host/update-engine/src/index.ts with esbuild into a single
 * dependency-free ESM file (the same artifact shape `pnpm run build` emits as
 * lib/index.js). The esbuild binary is resolved from the pnpm store because
 * it is not a direct dependency; a missing binary fails loudly.
 * @param outDir - directory for the produced bundle
 * @returns absolute path of the bundled engine
 */
export function engineBundle(outDir: string): string {
  const pnpmDir = join(repoRoot, 'node_modules/.pnpm')
  const versions = readdirSync(pnpmDir)
    .filter(name => /^esbuild@/u.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  let binary = ''
  for (const version of versions.reverse()) {
    const candidate = join(pnpmDir, version, 'node_modules/esbuild/bin/esbuild')
    if (existsSync(candidate)) {
      binary = candidate
      break
    }
  }
  if (binary === '') throw new Error('esbuild binary not found under node_modules/.pnpm')
  const out = join(outDir, 'engine-bundle.js')
  const result = spawnSync(binary, [
    join(repoRoot, 'packages/host/update-engine/src/index.ts'),
    '--bundle', '--format=esm', '--platform=node', '--target=node22', `--outfile=${out}`,
  ], { encoding: 'utf8', cwd: repoRoot })
  if (result.status !== 0) throw new Error(`esbuild failed: ${result.stderr}`)
  return out
}

/**
 * tar.gz a tree with the tree directory as the archive's top-level member.
 * @param treeDir - directory to pack (its basename becomes the top member)
 * @param outFile - archive path
 */
export function tarTree(treeDir: string, outFile: string): void {
  const result = spawnSync('tar', ['-czf', outFile, '-C', dirname(treeDir), basename(treeDir)], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`)
}
