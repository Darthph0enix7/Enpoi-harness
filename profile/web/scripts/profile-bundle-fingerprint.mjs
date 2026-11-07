#!/usr/bin/env node
/**
 * Content fingerprints for the profile's prebuilt enpoi-* plugin bundles.
 *
 * The profile ships `lib/index.js` inside a self-contained release, but source
 * checkouts do not have trustworthy mtimes: a checkout can give every file the
 * same timestamp, and a source edit can preserve the old one. This helper
 * therefore hashes the build inputs and the built bundle instead of comparing
 * times.
 *
 * One map lives at `<profile-root>/.bundle-fingerprints.json`:
 *
 *   {
 *     "version": 1,
 *     "packages": {
 *       "enpoi-one": {
 *         "sourceInputs": "<sha256>",
 *         "outputSha": "<sha256>",
 *         "buildFlags": "<sha256>"
 *       }
 *     }
 *   }
 *
 * `sourceInputs` covers the package's `src/**` TypeScript/JavaScript/JSON
 * files plus `package.json` and `tsconfig.json`, hashed in sorted relative-path
 * order. Root runtime data JSON is not part of the bundle, so editing it does
 * not force a pointless rebuild. `outputSha` is the SHA-256 of `lib/index.js`.
 * `buildFlags` is the SHA-256 of the canonical esbuild argv printed by
 * `flags`; the build script consumes that same list, keeping the fingerprint
 * and the actual compiler invocation on one source of truth.
 *
 * A prebuilt bundle may be skipped only when all three values match the files
 * on disk. Missing entries always request a build, so a source checkout or an
 * older install can never silently keep a stale bundle. Release builds set
 * `FORCE_BUILD=1` in `profile/web/build-plugins.sh` to regenerate this map for
 * every package before the artifact is staged.
 *
 * Source symlinks under `src` are rejected rather than silently skipped: a
 * link can point outside the package, and esbuild may follow it while this
 * hash could not describe the target safely.
 *
 * Usage:
 *   node profile-bundle-fingerprint.mjs flags
 *   node profile-bundle-fingerprint.mjs source-hash <profile-root> <package>
 *   node profile-bundle-fingerprint.mjs check <profile-root> <package>
 *   node profile-bundle-fingerprint.mjs record <profile-root> <package> [expected-source-inputs]
 *
 * `check` exits 0 when verified, 3 when the bundle must be rebuilt, and 2 on a
 * usage/helper error. This module has no dependencies and never writes outside
 * the profile root.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Fingerprint file at the profile root. */
export const FINGERPRINT_FILE = '.bundle-fingerprints.json'
/** Schema version written into the fingerprint file. */
export const FINGERPRINT_VERSION = 1
/** Canonical esbuild arguments shared by the build script and the hashes. */
export const BUILD_FLAGS = Object.freeze([
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--external:@deepseek-ai/*',
  '--external:schemastery',
  '--external:dsh-enpoi-*',
])

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'])
const ROOT_INPUT_FILES = ['package.json', 'tsconfig.json']
const SKIPPED_SOURCE_DIRS = new Set(['node_modules', '.git'])
const MAX_SOURCE_DEPTH = 16

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function regularFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function sourceFilesIn(directory, packageRoot, found, depth) {
  if (depth > MAX_SOURCE_DEPTH) {
    throw new Error(`source tree exceeds ${MAX_SOURCE_DEPTH} levels below ${packageRoot}`)
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const input = relative(packageRoot, path).split(sep).join('/')
      throw new Error(`source symlink is not supported (refusing to hash an unverifiable import): ${input}`)
    }
    if (entry.isDirectory()) {
      if (SKIPPED_SOURCE_DIRS.has(entry.name)) continue
      sourceFilesIn(path, packageRoot, found, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    found.add(relative(packageRoot, path).split(sep).join('/'))
  }
}

/**
 * Sorted package-relative paths that affect the bundle.
 * @param {string} packageDir plugin package directory
 * @returns {string[]} relative input paths
 */
export function collectSourceInputs(packageDir) {
  const root = resolve(packageDir)
  const found = new Set()
  for (const name of ROOT_INPUT_FILES) {
    if (regularFile(join(root, name))) found.add(name)
  }
  const src = join(root, 'src')
  if (existsSync(src)) {
    if (lstatSync(src).isSymbolicLink()) {
      throw new Error('source symlink is not supported (refusing to hash an unverifiable src directory): src')
    }
    sourceFilesIn(src, root, found, 0)
  }
  return [...found].sort()
}

/**
 * SHA-256 of the ordered build inputs (paths and contents).
 * @param {string} packageDir plugin package directory
 * @returns {string} lowercase hex digest
 */
export function sourceInputDigest(packageDir) {
  const root = resolve(packageDir)
  const hash = createHash('sha256')
  hash.update(`dsh-profile-bundle-source-v${FINGERPRINT_VERSION}\0`)
  for (const file of collectSourceInputs(root)) {
    const path = join(root, file)
    const data = readFileSync(path)
    hash.update(`${Buffer.byteLength(file)}:${file}\0`)
    hash.update(`${data.length}\0`)
    hash.update(data)
  }
  return hash.digest('hex')
}

/**
 * SHA-256 of a package's built bundle.
 * @param {string} packageDir plugin package directory
 * @returns {string | null} digest, or null when `lib/index.js` is absent
 */
export function outputDigest(packageDir) {
  const output = join(resolve(packageDir), 'lib', 'index.js')
  if (!regularFile(output)) return null
  return sha256(readFileSync(output))
}

/**
 * SHA-256 of the canonical build argv.
 * @param {readonly string[]} [flags] build arguments
 * @returns {string} lowercase hex digest
 */
export function buildFlagsDigest(flags = BUILD_FLAGS) {
  if (!Array.isArray(flags) || flags.length === 0 || flags.some(flag => typeof flag !== 'string' || flag === '')) {
    throw new TypeError('build flags must be a non-empty array of non-empty strings')
  }
  return sha256(JSON.stringify(flags))
}

/**
 * Validate a package directory name before it becomes a path segment.
 * @param {string} packageName directory name under `packages/`
 * @returns {string} unchanged name
 */
export function assertPackageName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new TypeError(`invalid profile package name: ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * Resolve a package directory under a profile root.
 * @param {string} profileRoot profile web root
 * @param {string} name directory name under `packages/`
 * @returns {string} absolute package directory
 */
export function packageDirectory(profileRoot, name) {
  return join(resolve(profileRoot), 'packages', assertPackageName(name))
}

/**
 * Fingerprint one built package. When `expectedSourceInputs` is supplied, the
 * current sources must still hash to it before the entry is created.
 * @param {string} packageDir plugin package directory
 * @param {readonly string[]} [flags] build arguments
 * @param {string} [expectedSourceInputs] source hash captured before the build
 * @returns {{ sourceInputs: string, outputSha: string, buildFlags: string }} entry
 */
export function fingerprintEntry(packageDir, flags = BUILD_FLAGS, expectedSourceInputs = undefined) {
  const sourceInputs = sourceInputDigest(packageDir)
  if (expectedSourceInputs !== undefined && sourceInputs !== expectedSourceInputs) {
    throw new Error(`source inputs changed during build (expected ${expectedSourceInputs}, got ${sourceInputs})`)
  }
  const outputSha = outputDigest(packageDir)
  if (outputSha === null) throw new Error(`no built bundle at ${join(packageDir, 'lib', 'index.js')}`)
  return {
    sourceInputs,
    outputSha,
    buildFlags: buildFlagsDigest(flags),
  }
}

function emptyManifest() {
  return { version: FINGERPRINT_VERSION, packages: {} }
}

/**
 * Read the fingerprint map. A missing, unreadable, or malformed map is treated
 * as empty so every package requests a build instead of inheriting trust.
 * @param {string} profileRoot profile web root
 * @returns {{ version: number, packages: Record<string, { sourceInputs: string, outputSha: string, buildFlags: string }> }} manifest
 */
export function readManifest(profileRoot) {
  const path = join(resolve(profileRoot), FINGERPRINT_FILE)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== FINGERPRINT_VERSION || parsed.packages === null || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages)) {
      return emptyManifest()
    }
    return { version: FINGERPRINT_VERSION, packages: parsed.packages }
  } catch {
    return emptyManifest()
  }
}

/**
 * Atomically replace the fingerprint map (temp file in the same directory).
 * @param {string} profileRoot profile web root
 * @param {{ packages: Record<string, { sourceInputs: string, outputSha: string, buildFlags: string }> }} manifest manifest to write
 * @returns {string} fingerprint file path
 */
export function writeManifest(profileRoot, manifest) {
  const root = resolve(profileRoot)
  const packages = {}
  for (const name of Object.keys(manifest.packages).sort()) {
    const entry = manifest.packages[name]
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.sourceInputs !== 'string' || typeof entry.outputSha !== 'string' || typeof entry.buildFlags !== 'string') continue
    packages[name] = {
      sourceInputs: entry.sourceInputs,
      outputSha: entry.outputSha,
      buildFlags: entry.buildFlags,
    }
  }
  mkdirSync(root, { recursive: true })
  const target = join(root, FINGERPRINT_FILE)
  const temporary = join(dirname(target), `.${FINGERPRINT_FILE.slice(1)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: FINGERPRINT_VERSION, packages }, null, 2)}\n`)
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return target
}

/**
 * Verify a package against its fingerprint.
 * @param {string} profileRoot profile web root
 * @param {string} name package directory name
 * @param {readonly string[]} [flags] current build arguments
 * @returns {{ ok: boolean, reason?: string, entry?: { sourceInputs: string, outputSha: string, buildFlags: string } }} result
 */
export function checkPackage(profileRoot, name, flags = BUILD_FLAGS) {
  const directory = packageDirectory(profileRoot, name)
  if (!existsSync(directory)) return { ok: false, reason: 'package directory missing' }
  const entry = readManifest(profileRoot).packages[name]
  if (entry === undefined) return { ok: false, reason: 'missing fingerprint' }
  if (typeof entry.sourceInputs !== 'string' || typeof entry.outputSha !== 'string' || typeof entry.buildFlags !== 'string') {
    return { ok: false, reason: 'invalid fingerprint entry' }
  }
  let sourceInputs
  try {
    sourceInputs = sourceInputDigest(directory)
  } catch (error) {
    return { ok: false, reason: `source inputs unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (entry.sourceInputs !== sourceInputs) return { ok: false, reason: 'source inputs changed' }
  const outputSha = outputDigest(directory)
  if (outputSha === null) return { ok: false, reason: 'bundle missing' }
  if (entry.outputSha !== outputSha) return { ok: false, reason: 'bundle content changed' }
  if (entry.buildFlags !== buildFlagsDigest(flags)) return { ok: false, reason: 'build flags changed' }
  return { ok: true, entry }
}

/**
 * Record a successfully built package in the profile fingerprint map. The
 * expected pre-build source hash prevents a concurrent source edit from
 * blessing bytes compiled from the old inputs.
 * @param {string} profileRoot profile web root
 * @param {string} name package directory name
 * @param {readonly string[]} [flags] build arguments used
 * @param {string} [expectedSourceInputs] source hash captured before the build
 * @returns {{ entry: { sourceInputs: string, outputSha: string, buildFlags: string }, file: string }} recorded entry and file path
 */
export function recordPackage(profileRoot, name, flags = BUILD_FLAGS, expectedSourceInputs = undefined) {
  const manifest = readManifest(profileRoot)
  const entry = fingerprintEntry(packageDirectory(profileRoot, name), flags, expectedSourceInputs)
  manifest.packages[name] = entry
  return { entry, file: writeManifest(profileRoot, manifest) }
}

function usage() {
  console.error('usage: profile-bundle-fingerprint.mjs flags | source-hash <profile-root> <package> | check <profile-root> <package> | record <profile-root> <package> [expected-source-inputs]')
}

function main(argv) {
  const [command, ...args] = argv
  if (command === 'flags') {
    if (args.length !== 0) throw new TypeError('flags takes no arguments')
    for (const flag of BUILD_FLAGS) console.log(flag)
    return 0
  }
  if (command === 'source-hash') {
    if (args.length !== 2) throw new TypeError('source-hash needs <profile-root> <package>')
    const [profileRoot, name] = args
    console.log(sourceInputDigest(packageDirectory(profileRoot, name)))
    return 0
  }
  if (command === 'check') {
    if (args.length !== 2) throw new TypeError('check needs <profile-root> <package>')
    const [profileRoot, name] = args
    const result = checkPackage(profileRoot, name)
    if (result.ok) {
      console.log(`VERIFIED ${name}`)
      return 0
    }
    console.log(`STALE ${name}: ${result.reason}`)
    return 3
  }
  if (command === 'record') {
    if (args.length !== 2 && args.length !== 3) throw new TypeError('record needs <profile-root> <package> [expected-source-inputs]')
    const [profileRoot, name, expectedSourceInputs] = args
    const { entry, file } = recordPackage(profileRoot, name, BUILD_FLAGS, expectedSourceInputs)
    console.log(`RECORDED ${name} ${entry.sourceInputs.slice(0, 12)} ${entry.outputSha.slice(0, 12)} ${file}`)
    return 0
  }
  usage()
  return 2
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(self)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`profile-bundle-fingerprint: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
