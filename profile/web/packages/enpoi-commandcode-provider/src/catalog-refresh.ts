/**
 * Command Code catalog snapshot: stamp, validation, and the owner-run refresh.
 *
 * `catalog.snapshot.json` is the bundled fallback the provider serves when no
 * live keypool catalog answers. It stays a bare array because the keypool
 * (the dotfiles `keypool/proxy.js` deployment) serves the file itself and
 * requires `Array.isArray(parsed)`; the stamp — version, fetch time, entry
 * count, source — lives in the sidecar `catalog.snapshot.meta.json` next to
 * it. `scripts/refresh-catalog.mjs` is the owner path: fetch the keypool
 * catalog, validate it whole, back the previous snapshot up, then write the
 * new snapshot and stamp.
 *
 * This module is self-contained at runtime (node builtins only, plus erased
 * type imports) so the refresh script can load it through Node's type
 * stripping without a build step.
 *
 * @module dsh-enpoi-commandcode-provider/catalog-refresh
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { CatalogSnapshotStamp } from './catalog.js'

/** The sidecar path holding a snapshot's stamp (`catalog.snapshot.json` → `catalog.snapshot.meta.json`). */
export function snapshotMetaPath(snapshotPath: string): string {
  return snapshotPath.endsWith('.json')
    ? `${snapshotPath.slice(0, -'.json'.length)}.meta.json`
    : `${snapshotPath}.meta.json`
}

/** Whether a wire value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a snapshot stamp. An absent or malformed sidecar means "unstamped":
 * the snapshot still serves, it just cannot report its provenance.
 * @param snapshotPath - the snapshot file the stamp belongs to.
 * @returns the stamp, or undefined.
 */
export function readSnapshotStamp(snapshotPath: string): CatalogSnapshotStamp | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(snapshotMetaPath(snapshotPath), 'utf8'))
    if (!isRecord(raw)) return undefined
    const version = raw.version
    const fetchedAt = raw.fetchedAt
    const entryCount = raw.entryCount
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return undefined
    if (typeof fetchedAt !== 'string' || fetchedAt === '') return undefined
    if (typeof entryCount !== 'number' || !Number.isSafeInteger(entryCount) || entryCount < 0) return undefined
    return {
      version,
      fetchedAt,
      entryCount,
      ...typeof raw.source === 'string' && raw.source !== '' ? { source: raw.source } : {},
    }
  } catch {
    return undefined
  }
}

/**
 * Validate a fetched catalog payload before it may replace the snapshot: a
 * non-empty array whose every row is an object with a non-empty string `id`
 * and `name`. The payload is preserved verbatim on write (unknown vendor
 * fields included), so validation rejects rather than normalizes.
 * @param raw - the parsed `catalog.json` payload.
 * @returns the validated rows.
 * @throws when the payload cannot serve as the snapshot.
 */
export function validateCatalogPayload(raw: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('catalog payload must be a non-empty array')
  const rows: Record<string, unknown>[] = []
  for (const row of raw) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('catalog payload has a non-object row')
    const record: Record<string, unknown> = row
    if (typeof record.id !== 'string' || record.id === '') throw new Error('catalog payload has a row without an id')
    if (typeof record.name !== 'string' || record.name === '') {
      throw new Error(`catalog payload row "${record.id}" has no name`)
    }
    rows.push(record)
  }
  return rows
}

/** Options for {@link refreshCatalogSnapshot}. */
export interface CatalogRefreshOptions {
  /** Keypool base URL; `/catalog.json` is appended. */
  baseURL: string
  /** Snapshot file to replace (its `.bak` sibling receives the previous copy). */
  snapshotPath: string
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Fetch timeout; defaults to 5 s. */
  timeoutMs?: number
  /** Injectable clock for tests. */
  now?: () => Date
}

/** What one refresh did. A failure never touches the previous files. */
export type CatalogRefreshOutcome =
  | {
      ok: true
      /** The validated payload written as the new snapshot. */
      entries: readonly Record<string, unknown>[]
      /** The stamp written beside it (version is previous + 1). */
      stamp: CatalogSnapshotStamp
      /** The previous snapshot's backup, when one existed. */
      backupPath?: string
    }
  | { ok: false; error: string }

/** Write `content` through a sibling temp file so a crash never truncates the target. */
function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, path)
}

/**
 * Re-fetch the keypool catalog and replace the snapshot in one validated
 * step: fetch → validate whole → back up the previous snapshot → write the
 * new snapshot and its stamp. Any failure leaves both files untouched.
 * @param options - keypool address, snapshot path, and test seams.
 * @returns the written stamp, or the failure reason.
 */
export async function refreshCatalogSnapshot(options: CatalogRefreshOptions): Promise<CatalogRefreshOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = `${options.baseURL.replace(/\/+$/, '')}/catalog.json`
  let payload: readonly Record<string, unknown>[]
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    })
    if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${String(response.status)}`)
    payload = validateCatalogPayload(JSON.parse(await response.text()) as unknown)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const stamp: CatalogSnapshotStamp = {
    version: (readSnapshotStamp(options.snapshotPath)?.version ?? 0) + 1,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    entryCount: payload.length,
    source: url,
  }
  let backupPath: string | undefined
  try {
    if (existsSync(options.snapshotPath)) {
      backupPath = `${options.snapshotPath}.bak`
      copyFileSync(options.snapshotPath, backupPath)
    }
    writeFileAtomic(options.snapshotPath, `${JSON.stringify(payload, null, 2)}\n`)
    writeFileAtomic(snapshotMetaPath(options.snapshotPath), `${JSON.stringify(stamp, null, 2)}\n`)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, entries: payload, stamp, ...backupPath === undefined ? {} : { backupPath } }
}
