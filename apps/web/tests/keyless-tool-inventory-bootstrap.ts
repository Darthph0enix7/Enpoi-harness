/**
 * Keyless inventory capture readiness — the safe, boot-free gate.
 *
 * This module is imported by the capture test BEFORE any harness/scaffold
 * import. It only reads repo files and fingerprints; it never boots the
 * composition, touches `~/.dsh`, or spawns a provider.
 *
 * The capture is BLOCKED unless every profile bundle's source/bundle/build
 * fingerprint matches the recorded map (the central build records it) and the
 * caller explicitly opts in with `DSH_KEYLESS_INVENTORY_CAPTURE=1`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const PROFILE_DIR = join(REPO_ROOT, 'profile', 'web')
export const PROFILE_PACKAGE = join(PROFILE_DIR, 'package.json')
export const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
export const COMPATIBILITY_FILE = join(PROFILE_DIR, 'compatibility.json')
export const CAPTURE_CONFIG = join(REPO_ROOT, 'scripts', 'tool-inventory', 'vitest.capture.config.ts')
export const VITEST_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vitest')


/** Existing client build record validated against the current client artifacts. */
export interface ClientBuildReceipt {
  readonly artifacts: { readonly fileCount: number; readonly sha256: string }
  readonly environment: Readonly<Record<string, string>>
}

/** Structural face of the built script's public `ClientBuildRecord` (read-only fields we consume). */
interface ClientBuildRecordFace {
  readonly artifacts: { readonly fileCount: number; readonly sha256: string }
  readonly environment: Readonly<Record<string, string>>
}

/** True when `child` is the base directory or inside it (separator-aware). */
export function pathWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(`${base}${sep}`)
}

export interface CaptureReadiness {
  readonly ready: boolean
  readonly blockers: readonly string[]
  readonly bundles: readonly string[]
  readonly localPackages: readonly string[]
  readonly clientBuild?: ClientBuildReceipt
}

interface ProfileManifest {
  dsh?: { profile?: { bundles?: unknown } }
}

interface FingerprintModule {
  checkPackage(profileRoot: string, name: string): { ok: boolean; reason?: string }
}

/** Read the shipped profile bundle list. */
export function profileBundles(): string[] {
  const manifest = JSON.parse(readFileSync(PROFILE_PACKAGE, 'utf8')) as ProfileManifest
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) {
    throw new Error(`${PROFILE_PACKAGE}: dsh.profile.bundles is not a string list`)
  }
  return bundles as string[]
}

/** Map package names to their repo profile package directories. */
function localPackageDirs(): Map<string, string> {
  const packages = join(PROFILE_DIR, 'packages')
  const out = new Map<string, string>()
  if (!existsSync(packages)) return out
  for (const entry of readdirSync(packages)) {
    const dir = join(packages, entry)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string') out.set(pkg.name, dir)
  }
  return out
}

/** Whether a bundle is a repo profile package (and therefore fingerprint-gated). */
export function localBundleDir(name: string): string | undefined {
  return localPackageDirs().get(name)
}

/** SHA-256 of one artifact, for capture provenance. */
export function artifactDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Compute the capture gate.
 * @returns readiness plus one actionable line per blocker.
 */
export async function captureReadiness(): Promise<CaptureReadiness> {
  const blockers: string[] = []
  if (process.env.DSH_KEYLESS_INVENTORY_CAPTURE !== '1') {
    blockers.push('explicit dispatch missing: set DSH_KEYLESS_INVENTORY_CAPTURE=1 only after the main central build')
  }
  if (!existsSync(COMPATIBILITY_FILE)) {
    blockers.push(`missing shipped exemption file ${COMPATIBILITY_FILE}`)
  }
  if (!existsSync(VITEST_BIN) || !existsSync(CAPTURE_CONFIG)) {
    blockers.push(`missing isolated capture runner (${VITEST_BIN} / ${CAPTURE_CONFIG})`)
  }
  if (!existsSync(join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html'))) {
    blockers.push('web dist missing; run the repo build (the scaffold requires it even though no browser opens)')
  }
  let clientBuild: ClientBuildReceipt | undefined
  try {
    // Runtime uses the EXISTING built JS public boundary (the declaration lives
    // in scripts/types); the computed URL keeps the TS client program from
    // resolving the script's source across rootDir.
    const built = new URL('../../../scripts/client-build-environment.js', import.meta.url)
    const module = await import(/* @vite-ignore */ built.href) as { readClientBuildRecord?: unknown }
    if (typeof module.readClientBuildRecord !== 'function') throw new Error(`${built.pathname} does not export readClientBuildRecord`)
    const record = (module.readClientBuildRecord as (root: string) => ClientBuildRecordFace)(REPO_ROOT)
    clientBuild = { artifacts: record.artifacts, environment: record.environment }
  } catch (error) {
    blockers.push(`client build record is not verifiable against the current artifacts: ${error instanceof Error ? error.message : String(error)}`)
  }

  const bundles = profileBundles()
  // Every local profile package can be loaded (host bundle or preset row), so
  // every one must have a fresh central-build fingerprint, not just bundles.
  const localPackages = [...localPackageDirs().keys()]
  let fingerprints: FingerprintModule
  try {
    fingerprints = await import(join(PROFILE_DIR, 'scripts', 'profile-bundle-fingerprint.mjs')) as FingerprintModule
  } catch (error) {
    blockers.push(`profile fingerprint helper is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return { ready: false, blockers, bundles, localPackages }
  }
  for (const name of localPackages) {
    const dir = localBundleDir(name)!
    if (!existsSync(join(dir, 'lib', 'index.js'))) {
      blockers.push(`profile package ${name}: lib/index.js missing — run the central profile build`)
      continue
    }
    const result = fingerprints.checkPackage(PROFILE_DIR, basename(dir))
    if (!result.ok) blockers.push(`profile package ${name} fingerprint not fresh: ${result.reason ?? 'unknown'}`)
  }

  // The settings row must remain a real profile row; a malformed patch split
  // would silently launch a partial composition.
  const patch = readFileSync(PROFILE_PATCH, 'utf8')
  if (!patch.includes('- id: enpoi-orchestration\\n') && !patch.includes('- id: enpoi-orchestration\n')) {
    blockers.push('profile patch has no enpoi-orchestration settings row')
  }

  return { ready: blockers.length === 0, blockers, bundles, localPackages, ...clientBuild === undefined ? {} : { clientBuild } }
}

/** The repo that owns this readiness gate (for the test's error text). */
export const READINESS_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'keyless-tool-inventory-bootstrap.ts')
