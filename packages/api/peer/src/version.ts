/**
 * Harness version reported in the peer handshake.
 *
 * The value is the running package manifest's `version`, the same source
 * `getDshRuntimeVersion()` in `@deepseek-ai/dsh-app-boot` reads for
 * `dsh --version` and plugin compatibility. Every workspace package carries
 * that version, so reading this package's manifest reports the shipped harness
 * release without a literal that drifts.
 *
 * @module @deepseek-ai/dsh-api-peer/version
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Extract a non-empty version string from a parsed package manifest.
 * @param manifest - parsed `package.json` value.
 * @returns the manifest's `version` field.
 * @throws Error when the field is absent, blank, or not a string, because a
 * handshake with an empty identity is worse than a loud broken installation.
 */
export function manifestVersionOf(manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('peer harness version: package.json must be an object')
  }
  const version = (manifest as { version?: unknown }).version
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('peer harness version: package.json must carry a non-empty version')
  }
  return version
}

/**
 * Read this package's manifest version beside the running module. The URL
 * resolves from both `src/version.ts` and a bundled `lib/index.js`, so source
 * runs, tests, and the emitted host/client bundles report the same value.
 * @returns the harness version.
 * @throws Error when the manifest is missing, unreadable, or malformed.
 */
export function readHarnessVersion(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as unknown
  return manifestVersionOf(manifest)
}

/** Harness version this build reports in `peer.handshake` unless configured. */
export const HARNESS_VERSION: string = readHarnessVersion()
