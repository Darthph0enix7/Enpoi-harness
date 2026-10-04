#!/usr/bin/env node
/**
 * Idempotent local wiring for the Command Code provider package.
 *
 * Run by the heavy-provider local install step (and safe to re-run by hand):
 * adds the package to the web profile's dependencies and bundle list, links it
 * into the profile's node_modules, and builds its esbuild bundle. It never
 * starts or restarts any service.
 *
 * Usage: node scripts/install.mjs [profileRoot]
 */

import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-enpoi-commandcode-provider'
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.HOME ?? ''
const profileRoot = resolve(process.argv[2] ?? process.env.DSH_PROFILE_ROOT ?? join(home, '.dsh', 'profiles', 'web'))

function fail(message) {
  console.error(`[${PACKAGE_NAME}] ${message}`)
  process.exit(1)
}

if (!existsSync(join(profileRoot, 'package.json'))) fail(`profile root not found at ${profileRoot}`)
if (!existsSync(join(packageRoot, 'src', 'index.ts'))) fail(`package source not found at ${packageRoot}`)

// 1. Profile dependency + bundle list.
const manifestPath = join(profileRoot, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dependencies[PACKAGE_NAME] = 'workspace:*'
const profile = (manifest.dsh ??= {})
const profileSection = (profile.profile ??= {})
const bundles = (profileSection.bundles ??= [])
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
const { writeFileSync } = await import('node:fs')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[${PACKAGE_NAME}] profile dependency + bundle list updated`)

// 2. Link into the profile's node_modules (hoisted linker: a plain symlink).
const linkPath = join(profileRoot, 'node_modules', PACKAGE_NAME)
mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
try {
  const stat = lstatSync(linkPath)
  if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(linkPath, { recursive: true, force: true })
} catch {
  // absent link is the normal first-run case
}
symlinkSync(join('..', 'packages', PACKAGE_NAME), linkPath)
console.log(`[${PACKAGE_NAME}] linked into node_modules`)

// 3. Reconcile the workspace lockfile when pnpm is available (best effort).
const pnpm = spawnSync('pnpm', ['--dir', profileRoot, 'install', '--ignore-scripts', '--prefer-offline'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (pnpm.error !== undefined) {
  console.warn(`[${PACKAGE_NAME}] pnpm not available (${pnpm.error.message}); manual symlink above keeps the plugin resolvable`)
}

// 4. Build the bundle with the profile's esbuild.
const esbuild = join(profileRoot, 'node_modules', '.bin', 'esbuild')
if (!existsSync(esbuild)) fail(`esbuild not found at ${esbuild} — run pnpm install in ${profileRoot}`)
const build = spawnSync(esbuild, [
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--external:@deepseek-ai/*',
  '--external:schemastery',
  '--external:dsh-enpoi-*',
  '--outfile=lib/index.js',
], { cwd: packageRoot, stdio: 'inherit' })
if (build.status !== 0) fail('esbuild build failed')
console.log(`[${PACKAGE_NAME}] built lib/index.js — restart the harness to mount the route`)
