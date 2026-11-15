/**
 * Test-only artifact receipt for the keyless tool-inventory capture.
 *
 * One pure-file computation shared by the capture runner and the profile
 * fixture gate. It records the current compiled artifacts (profile bundles,
 * external profile bundles, bounded host packages) and their fingerprint
 * inputs. The existing client build record (`scripts/client-build-environment.ts`)
 * validates the Vite/dist artifacts separately; this file never parses
 * arbitrary source or writes build state.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const PROFILE_PACKAGES = 'profile/web/packages'
const PROFILE_PACKAGE_JSON = 'profile/web/package.json'
const HOST_PACKAGES = [
  'apps/cli',
  'packages/boot/app-boot',
  'packages/core/scope',
  'packages/core/tools',
  'packages/llm/llm',
  'packages/bundle/base',
  'packages/bundle/web-app',
]

/** @param {Buffer|string} data @returns {string} */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {string} file @returns {string|null} */
function fileDigest(file) {
  return existsSync(file) && statSync(file).isFile() ? sha256(readFileSync(file)) : null
}

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Package identity + tracked manifest + declared entry artifact digest.
 * @param {string} repoRoot @param {string} dir
 * @returns {{name:string,version:string|null,packageJson:string|null,entry:string|null}|undefined} */
function packageReceipt(repoRoot, dir) {
  const manifestPath = join(repoRoot, dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = readJson(manifestPath)
  if (typeof manifest.name !== 'string') return undefined
  const main = typeof manifest.main === 'string' ? manifest.main : 'lib/index.js'
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    packageJson: fileDigest(manifestPath),
    entry: fileDigest(join(repoRoot, dir, main)),
  }
}

/** Local profile package fingerprints: name → source/output/build digest.
 * @param {string} repoRoot
 * @returns {Promise<Record<string,{dir:string,sourceInputs:string|null,outputSha:string|null}>>} */
async function profileFingerprints(repoRoot) {
  const helper = await import(join(repoRoot, 'profile/web/scripts/profile-bundle-fingerprint.mjs'))
  const dir = join(repoRoot, PROFILE_PACKAGES)
  /** @type {Record<string,{dir:string,sourceInputs:string|null,outputSha:string|null}>} */
  const out = {}
  for (const entry of readdirSync(dir)) {
    const packageDir = join(dir, entry)
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (typeof manifest.name !== 'string') continue
    let entryDigest = null
    let sourceInputs = null
    try {
      const fingerprint = helper.fingerprintEntry(packageDir)
      entryDigest = fingerprint.outputSha
      sourceInputs = fingerprint.sourceInputs
    } catch {
      // A package without a readable src/lib is recorded as null; readiness
      // must have blocked before capture in that case.
    }
    out[manifest.name] = { dir: entry, sourceInputs, outputSha: entryDigest }
  }
  return out
}

/** External profile dependencies: version + tracked manifest + entry digest.
 * @param {string} repoRoot
 * @returns {Record<string,{version:string|null,packageJson:string|null,entry:string|null,missing?:boolean}>} */
function externalBundles(repoRoot) {
  const profile = readJson(join(repoRoot, PROFILE_PACKAGE_JSON))
  const local = new Set(Object.keys(profileFingerprintsSyncNames(repoRoot)))
  /** @type {Record<string,{version:string|null,packageJson:string|null,entry:string|null,missing?:boolean}>} */
  const out = {}
  for (const name of Object.keys(profile.dependencies ?? {}).sort()) {
    if (local.has(name)) continue
    let dir
    try {
      dir = realpathSync(join(repoRoot, 'profile/web/node_modules', name))
    } catch {
      out[name] = { version: null, packageJson: null, entry: null, missing: true }
      continue
    }
    const receipt = packageReceipt(repoRoot, relativePath(repoRoot, dir))
    out[name] = receipt === undefined
      ? { version: null, packageJson: null, entry: null, missing: true }
      : { version: receipt.version, packageJson: receipt.packageJson, entry: receipt.entry }
  }
  return out
}

/** @param {string} repoRoot @returns {Record<string,string>} */
function profileFingerprintsSyncNames(repoRoot) {
  /** @type {Record<string,string>} */
  const out = {}
  const dir = join(repoRoot, PROFILE_PACKAGES)
  for (const entry of readdirSync(dir)) {
    const manifestPath = join(dir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (typeof manifest.name === 'string') out[manifest.name] = entry
  }
  return out
}

/** @param {string} root @param {string} file @returns {string} */
function relativePath(root, file) {
  const base = resolve(root)
  const target = resolve(file)
  if (!target.startsWith(`${base}${sep}`) && target !== base) return target
  return target.slice(base.length + 1)
}

/**
 * Build the canonical receipt.
 * @param {string} repoRoot repository root
 * @returns {Promise<{ version: string|null, head: string|null, profileFingerprints: object, externalBundles: object, hostPackages: object, combinedDigest: string }>}
 */
export async function buildArtifactReceipt(repoRoot) {
  const root = resolve(repoRoot)
  const profile = readJson(join(root, PROFILE_PACKAGE_JSON))
  let version = typeof profile.version === 'string' ? profile.version : null
  if (version === null) {
    try {
      const base = readJson(join(root, 'packages/bundle/base/package.json'))
      if (typeof base.version === 'string') version = base.version
    } catch {
      // A checkout without the built base bundle keeps null; readiness blocks.
    }
  }
  /** @type {Record<string,{name:string,version:string|null,packageJson:string|null,entry:string|null}>} */
  const hostPackages = {}
  for (const dir of HOST_PACKAGES) {
    const receipt = packageReceipt(root, dir)
    if (receipt !== undefined) hostPackages[receipt.name] = receipt
  }
  const receipt = {
    version,
    head: typeof process.env.DSH_KEYLESS_INVENTORY_HEAD === 'string' ? process.env.DSH_KEYLESS_INVENTORY_HEAD : null,
    profileFingerprints: await profileFingerprints(root),
    externalBundles: externalBundles(root),
    hostPackages,
  }
  // HEAD is INFORMATIONAL only: an atomic commit loop may change it without
  // changing artifacts. It is deliberately excluded from the receipt gate.
  const { head: _informationalHead, ...digestBasis } = receipt
  return { ...receipt, combinedDigest: sha256(JSON.stringify(digestBasis)) }
}
