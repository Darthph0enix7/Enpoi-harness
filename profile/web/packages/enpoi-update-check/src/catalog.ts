/**
 * enpoi-update-check — catalog consumption and the install identity
 * (docs/plan/ui-update-manifest.md P2).
 *
 * Decorator-free and dependency-light so the profile vitest pipeline can test
 * every decision: the version comparator, catalog validation, the fetch, and
 * the install-state read. Nothing here ever throws through a caller that did
 * not ask for it — the fetch is the only I/O and its errors are the caller's
 * to handle.
 *
 * @module dsh-enpoi-update-check/catalog
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Catalog schema this plugin understands. */
export const CATALOG_SCHEMA_VERSION = 1

/**
 * Catalog fetch base. The file is maintained by harness-release.yml on the
 * `catalog` branch as `<channel>.json` at the branch root, so the raw URL is
 * `.../catalog/<channel>.json`:
 *   https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/stable.json
 *   https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/beta.json
 */
export const CATALOG_RAW_BASE_URL = 'https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog'

/** Fetch timeout for one catalog check; no retries beyond the next interval. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000

/** One release entry as the generator writes it. */
export interface CatalogEntry {
  /** Release tag without the leading `v` (e.g. `0.1.7-enpoi.2.84`). */
  readonly version: string
  /** Short commit prefix the release tag points at. */
  readonly commit: string
  /** Tag date, ISO 8601. */
  readonly releasedAt: string
  /** Commit subjects between the previous release and this one. */
  readonly notes: string[]
}

/** This install's recorded identity (`install-state.json`). */
export interface InstallIdentity {
  /** `stable` unless install-state records `beta`. */
  readonly channel: string
  /** Installed version; empty when the state file and fallback are unreadable. */
  readonly version: string
  /** Installed commit prefix; empty when unrecorded. */
  readonly commit: string
}

/** The catalog URL for one channel. */
export function catalogUrl(channel: string): string {
  return `${CATALOG_RAW_BASE_URL}/${channel === 'beta' ? 'beta' : 'stable'}.json`
}

/**
 * Compare two release versions segment by segment; numeric segments compare
 * numerically, so `0.1.7-enpoi.2.9 < 0.1.7-enpoi.2.10` and a missing trailing
 * segment is older (`0.1.7-enpoi.2 < 0.1.7-enpoi.2.81`).
 *
 * @param left - version text, with or without a leading `v`.
 * @param right - version text, with or without a leading `v`.
 * @returns -1/0/1, or null when either side is not comparable (empty, no
 *   alphanumeric-segment shape, or a numeric/text kind mismatch at one index).
 */
export function compareVersions(left: string, right: string): number | null {
  const leftTokens = versionTokens(left)
  const rightTokens = versionTokens(right)
  if (leftTokens === null || rightTokens === null) return null
  const length = Math.max(leftTokens.length, rightTokens.length)
  for (let index = 0; index < length; index++) {
    const a = leftTokens[index]
    const b = rightTokens[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a < b ? -1 : 1
      continue
    }
    if (typeof a === 'string' && typeof b === 'string') {
      if (a !== b) return a < b ? -1 : 1
      continue
    }
    // A numeric segment on one side and a text segment on the other is not a
    // version pair this comparator can order.
    return null
  }
  return 0
}

/** Split a version into comparable numeric/text segments, or null when unusable. */
function versionTokens(version: unknown): (number | string)[] | null {
  if (typeof version !== 'string') return null
  const text = version.trim().replace(/^v/i, '')
  if (text === '' || text.length > 128) return null
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(text)) return null
  const segments = text.split(/[.+_-]+/)
  if (!segments.some(segment => /^[0-9]+$/.test(segment))) return null
  return segments.map(segment => (/^[0-9]+$/.test(segment) ? Number(segment) : segment))
}

/** Whether a parsed JSON value looks like one catalog entry. */
function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.version !== 'string' || entry.version === '') return false
  if (typeof entry.commit !== 'string' || typeof entry.releasedAt !== 'string') return false
  if (!Array.isArray(entry.notes) || !entry.notes.every(note => typeof note === 'string')) return false
  return true
}

/**
 * Validate a fetched catalog document for `channel`.
 *
 * @param value - parsed JSON value.
 * @param channel - channel the document must declare.
 * @returns the release entries (possibly empty), or null when the document is
 *   malformed: wrong schema version, wrong channel, missing `releases`, or no
 *   valid entry.
 */
export function parseCatalogDocument(value: unknown, channel: string): CatalogEntry[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const document = value as Record<string, unknown>
  if (document.schemaVersion !== CATALOG_SCHEMA_VERSION) return null
  if (document.channel !== channel) return null
  if (!Array.isArray(document.releases)) return null
  const releases = document.releases.filter(isCatalogEntry)
  return releases.length === 0 ? null : releases
}

/**
 * Fetch and validate the catalog for `channel`.
 *
 * @param channel - install channel (`stable` or `beta`).
 * @param fetchImpl - fetch implementation (tests inject a stub).
 * @returns the release entries, newest first.
 * @throws Error on a transport failure, non-2xx response, or malformed body.
 */
export async function fetchCatalog(
  channel: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogEntry[]> {
  const response = await fetchImpl(catalogUrl(channel), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`)
  const text = await response.text()
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error('catalog fetch failed: invalid JSON')
  }
  const entries = parseCatalogDocument(document, channel)
  if (entries === null) throw new Error('catalog fetch failed: malformed document')
  return entries
}

/** Read `version` from a package.json file, or null when unreadable. */
function readPackageVersion(file: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Read this install's identity from `$DSH_HOME/harness/install-state.json`.
 *
 * The channel defaults to `stable` when the state file is absent, unreadable,
 * or records another value. The version falls back to the running harness
 * tree's package.json (`<prefix>/harness/current/package.json`, then
 * `<home>/harness/current/package.json`) when the state file has none.
 *
 * @param homeDir - harness home (resolved `$DSH_HOME`).
 * @returns the identity; fields are empty strings when nothing is readable.
 */
export function readInstallIdentity(homeDir: string): InstallIdentity {
  let state: Record<string, unknown> = {}
  try {
    state = JSON.parse(readFileSync(join(homeDir, 'harness', 'install-state.json'), 'utf8')) as Record<string, unknown>
  } catch {
    state = {}
  }
  const channel = state.channel === 'beta' ? 'beta' : 'stable'
  const recorded = typeof state.version === 'string' && state.version !== '' ? state.version : null
  const prefix = typeof state.prefix === 'string' && state.prefix !== '' ? state.prefix : homeDir
  const version = recorded
    ?? readPackageVersion(join(prefix, 'harness', 'current', 'package.json'))
    ?? readPackageVersion(join(homeDir, 'harness', 'current', 'package.json'))
    ?? ''
  return {
    channel,
    version,
    commit: typeof state.commit === 'string' ? state.commit : '',
  }
}
