/**
 * Caller identity for the peer handshake: the harness version this profile
 * runs under.
 *
 * The harness client reports its own package manifest's version; this caller
 * is a profile plugin with no runtime dependency on that package, so the
 * resolver reads the same installed identity without importing anything:
 * the `@deepseek-ai/dsh-api-peer` manifest beside the running profile (the
 * library client's own version source), or the installer's
 * `harness/install-state.json` under `$DSH_HOME` (the identity `dsh --version`
 * reports). A build where neither exists fails closed, naming the env
 * override, instead of sending a made-up version: the field is advisory on the
 * wire, but a fake build identity is still worse than a loud broken install.
 *
 * @module dsh-enpoi-peer-bridge/caller-version
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Env override for the caller harness version; the documented escape hatch. */
export const CALLER_HARNESS_VERSION_ENV = 'DSH_PEER_HARNESS_VERSION'

/** How many parent directories the adjacent-manifest walk inspects. */
const ADJACENT_WALK_DEPTH = 6

/** Failure raised when no caller identity can be resolved. */
export class CallerVersionError extends Error {
  /** Peer error code the tool layer reports for this failure. */
  readonly code = 'gateway/internal'

  /**
   * @param message - the failure, naming every source and the env override.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CallerVersionError'
  }
}

/** Lookup roots and overrides; every field defaults to the running install. */
export interface CallerVersionSources {
  /** Explicit version (the client option wins over everything else). */
  readonly harnessVersion?: string
  /** Harness home holding `harness/install-state.json`; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
  /** Direct `@deepseek-ai/dsh-api-peer` manifest path; defaults to the adjacent-manifest walk. */
  readonly peerManifestPath?: string
  /** Environment read for the override and `DSH_HOME`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Read a non-empty string field from one JSON manifest.
 * @param path - manifest path.
 * @param key - field to read (defaults to `version`).
 * @returns the trimmed value, or undefined when the file is absent, malformed,
 * or the field is not a non-empty string.
 */
function manifestStringAt(path: string, key = 'version'): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>)[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Find `<dir>/node_modules/@deepseek-ai/dsh-api-peer/package.json` along the
 * parents of this module. The walk is a plain file probe, so it works in a
 * source checkout, in the emitted `lib/index.js`, and in an installed profile
 * without depending on the process module resolver.
 * @param moduleUrl - this module's URL.
 * @returns the manifest path, or undefined when no parent carries it.
 */
export function adjacentPeerManifest(moduleUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let depth = 0; depth < ADJACENT_WALK_DEPTH; depth += 1) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh-api-peer', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Resolve the harness version this caller reports in `peer.handshake`.
 * @param sources - explicit override plus lookup roots for tests.
 * @returns the non-empty harness version string.
 * @throws {@link CallerVersionError} when no real source resolves.
 */
export function resolveCallerHarnessVersion(sources: CallerVersionSources = {}): string {
  const env = sources.env ?? process.env
  const explicit = sources.harnessVersion ?? env[CALLER_HARNESS_VERSION_ENV]
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const manifest = sources.peerManifestPath ?? adjacentPeerManifest(import.meta.url)
  const adjacent = manifest === undefined ? undefined : manifestStringAt(manifest)
  if (adjacent !== undefined) return adjacent
  const home = sources.dshHome ?? (env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh'))
  const installed = manifestStringAt(join(home, 'harness', 'install-state.json'))
  if (installed !== undefined) return installed
  throw new CallerVersionError(
    `cannot determine the caller harness version (no ${CALLER_HARNESS_VERSION_ENV}, no @deepseek-ai/dsh-api-peer manifest beside this plugin, and no harness/install-state.json under ${home}) — set ${CALLER_HARNESS_VERSION_ENV} to this build's version`,
  )
}
