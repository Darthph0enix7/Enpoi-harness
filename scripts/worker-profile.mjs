/** Select one versioned release without copying or merging its worker composition. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleName = 'dsh-enpoi-jarvis-worker'
const ownRelease = fileURLToPath(new URL('..', import.meta.url))

/** @param {string} release - selected release root. @returns {string} Bundle directory. */
export function workerBundleDirectory(release) {
  return join(realpathSync(release), 'profile/web/packages/enpoi-jarvis-worker')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {string} release - selected release root. @returns {{version: number, hash: string, tools: {name: string, description: string, inputSchema: object}[]}} Verified release manifest. */
export function workerManifest(release) {
  const manifest = JSON.parse(readFileSync(join(workerBundleDirectory(release), 'knowledge-tools.json'), 'utf8'))
  const shapes = manifest.tools.map(({ name, inputSchema }) => ({ name, inputSchema }))
  shapes.sort((a, b) => a.name.localeCompare(b.name))
  const hash = createHash('sha256').update(canonicalJson(shapes)).digest('hex')
  if (hash !== manifest.hash || !Number.isSafeInteger(manifest.version) || manifest.version < 1) {
    throw new Error('worker release knowledge manifest failed its version/hash check')
  }
  return manifest
}

function privateDirectory(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('worker attempt directories must be real, process-owned directories with mode 0700')
  }
}

/**
 * Seed only the built-in selector. A reused attempt may only retain the exact same release and no overrides.
 * @param {string} release - immutable release root, not a mutable current symlink at boot.
 * @param {string} home - existing process-owned 0700 attempt home.
 * @returns {string} Selected profile directory.
 */
export function seedWorkerProfile(release, home) {
  if (!isAbsolute(home)) throw new Error('worker DSH_HOME must be absolute')
  privateDirectory(home)
  const homeEntries = readdirSync(home)
  if (homeEntries.some(name => name === 'cordis.patch.yml' || name === '.env' || name === 'settings.yaml')) {
    throw new Error('unexpected home override in worker DSH_HOME')
  }
  const profiles = join(home, 'profiles')
  if (!homeEntries.includes('profiles')) mkdirSync(profiles, { mode: 0o700 })
  privateDirectory(profiles)
  const profilesEntries = readdirSync(profiles)
  if (profilesEntries.some(name => name !== 'jarvis-worker')) throw new Error('worker DSH_HOME must not contain another profile')
  const selected = join(profiles, 'jarvis-worker')
  const bundle = workerBundleDirectory(release)
  workerManifest(release)
  const selector = readFileSync(join(bundle, 'selector.json'))
  if (profilesEntries.includes('jarvis-worker')) {
    privateDirectory(selected)
    const modules = join(selected, 'node_modules')
    privateDirectory(modules)
    if (readdirSync(selected).sort().join(',') !== 'cordis.yml,node_modules,package.json'
      || readdirSync(modules).join(',') !== bundleName
      || !lstatSync(join(selected, 'cordis.yml')).isFile()
      || readFileSync(join(selected, 'cordis.yml'), 'utf8') !== '[]\n'
      || !lstatSync(join(selected, 'package.json')).isFile()
      || !selector.equals(readFileSync(join(selected, 'package.json')))) {
      throw new Error('unexpected worker profile override; provision a new DSH_HOME')
    }
    if (readlinkSync(join(modules, bundleName)) !== bundle) throw new Error('worker attempt selects another release')
    return selected
  }
  const stage = mkdtempSync(join(profiles, '.jarvis-worker-'))
  try {
    const modules = join(stage, 'node_modules')
    mkdirSync(modules, { mode: 0o700 })
    symlinkSync(bundle, join(modules, bundleName), 'dir')
    writeFileSync(join(stage, 'package.json'), selector, { mode: 0o400, flag: 'wx' })
    writeFileSync(join(stage, 'cordis.yml'), '[]\n', { mode: 0o400, flag: 'wx' })
    renameSync(stage, selected)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  return selected
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const home = process.argv[2] ?? process.env.DSH_HOME
    if (home === undefined || process.argv.length > 4) throw new Error('usage: node scripts/worker-profile.mjs [absolute-attempt-home [release-root]]')
    seedWorkerProfile(process.argv[3] ?? ownRelease, home)
  } catch (error) {
    process.stderr.write(`worker profile: ${error instanceof Error ? error.message : 'seeding failed'}\n`)
    process.exitCode = 1
  }
}
