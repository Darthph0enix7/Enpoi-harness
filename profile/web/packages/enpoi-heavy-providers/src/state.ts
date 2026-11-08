/**
 * enpoi-heavy-providers — persisted provider lifecycle ownership.
 *
 * Each provider's facts live in `$DSH_HOME/heavy-providers/<encoded-id>.json`
 * as a version-1 record: a route-only reuse, or a local install the trusted
 * host installer proved it owns with an explicit receipt. Per-provider files
 * make updates independent, so two installs finishing at once cannot lose each
 * other's record. The legacy aggregate `$DSH_HOME/heavy-providers.json` is
 * still read for providers that have no per-provider file; it is never
 * written. Clearing a provider writes a tombstone in its own file so the old
 * aggregate entry cannot resurrect. No record carries secrets, and every
 * write is atomic. A missing, malformed, or older record is `unknown`: it
 * never authorizes running a static teardown, and a route address or display
 * name is never used to infer it.
 *
 * @module dsh-enpoi-heavy-providers/state
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Directory under `$DSH_HOME` holding one lifecycle file per provider. */
export const HEAVY_LIFECYCLE_DIRECTORY = 'heavy-providers'

/** Legacy aggregate record file name; read-only compatibility. */
export const HEAVY_LIFECYCLE_FILE = 'heavy-providers.json'

/** The only record version this host understands. */
export const HEAVY_LIFECYCLE_VERSION = 1

/** How the current provider entry was created. */
export type HeavyLifecycleMode = 'reuse' | 'local'

/** How the instance was introduced to the harness. */
export type HeavySetupKind = 'harness-install' | 'detected-instance' | 'custom-instance'

/** One provider's durable lifecycle facts. */
export interface HeavyLifecycleEntry {
  /** `reuse` for a detected instance, `local` for an install this harness owns. */
  mode: HeavyLifecycleMode
  /**
   * True only when a local install returned a verifiable ownership receipt.
   * A reused instance is never owned, and an install without a receipt is
   * not recorded as `local` at all.
   */
  installedByHarness: boolean
  /**
   * Opaque installer receipt proving the local install belongs to this
   * harness. Bounded text, never a credential or secret.
   */
  receipt?: string
  /**
   * Specific setup provenance: whether the harness installed it locally,
   * detected a pre-existing local listener, or the operator typed a custom endpoint.
   */
  setupKind?: HeavySetupKind
  /** The configured endpoint / baseURL at the time of setup. */
  endpoint?: string
  /** Unix epoch milliseconds of the last lifecycle commit. */
  updatedAt: number
}

/** The persisted lifecycle document (the legacy aggregate's shape). */
export interface HeavyLifecycleDocument {
  version: typeof HEAVY_LIFECYCLE_VERSION
  providers: Record<string, HeavyLifecycleEntry>
}

/** Longest accepted receipt; an opaque proof token, not a payload. */
const MAX_RECEIPT_CHARS = 512

/** The legacy aggregate path; read-only compatibility. */
export function heavyLifecyclePath(dshHome: string): string {
  return join(dshHome, HEAVY_LIFECYCLE_FILE)
}

/**
 * The directory holding one file per provider.
 * @param dshHome - the DSH home directory.
 * @returns the absolute lifecycle directory path.
 */
export function heavyLifecycleDirectory(dshHome: string): string {
  return join(dshHome, HEAVY_LIFECYCLE_DIRECTORY)
}

/**
 * One provider's lifecycle file path. The id is URI-encoded so it can never
 * address a path outside the lifecycle directory.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 * @returns the absolute per-provider lifecycle path.
 */
export function providerLifecyclePath(dshHome: string, id: string): string {
  if (id === '') throw new Error('heavy-provider lifecycle id is empty')
  return join(heavyLifecycleDirectory(dshHome), `${encodeURIComponent(id)}.json`)
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The filesystem error code, when the value carries one. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** Sanitize one persisted entry; undefined for a malformed record. */
function readEntry(raw: unknown): HeavyLifecycleEntry | undefined {
  if (!isRecord(raw)) return undefined
  const mode = raw.mode
  if (mode !== 'reuse' && mode !== 'local') return undefined
  if (typeof raw.installedByHarness !== 'boolean') return undefined
  const receipt = raw.receipt
  if (receipt !== undefined && (typeof receipt !== 'string' || receipt === '' || receipt.length > MAX_RECEIPT_CHARS)) {
    return undefined
  }
  // A local entry without a receipt cannot prove ownership; treat it as a
  // malformed record rather than granting uninstall authority.
  if (mode === 'local' && (raw.installedByHarness !== true || receipt === undefined)) return undefined
  if (mode === 'reuse' && raw.installedByHarness !== false) return undefined
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return undefined
  const setupKind = raw.setupKind
  const validSetupKind = setupKind === 'harness-install' || setupKind === 'detected-instance' || setupKind === 'custom-instance'
    ? setupKind
    : undefined
  const endpoint = typeof raw.endpoint === 'string' && raw.endpoint.length > 0 && raw.endpoint.length <= 2048
    ? raw.endpoint
    : undefined
  return {
    mode,
    installedByHarness: raw.installedByHarness,
    ...receipt === undefined ? {} : { receipt },
    ...validSetupKind === undefined ? {} : { setupKind: validSetupKind },
    ...endpoint === undefined ? {} : { endpoint },
    updatedAt: raw.updatedAt,
  }
}

/** Read the legacy aggregate; malformed or foreign versions answer empty. */
function readLegacyAggregate(dshHome: string): HeavyLifecycleDocument {
  try {
    const raw: unknown = JSON.parse(readFileSync(heavyLifecyclePath(dshHome), 'utf8'))
    if (!isRecord(raw) || raw.version !== HEAVY_LIFECYCLE_VERSION || !isRecord(raw.providers)) {
      return { version: HEAVY_LIFECYCLE_VERSION, providers: {} }
    }
    const providers: Record<string, HeavyLifecycleEntry> = {}
    for (const [id, value] of Object.entries(raw.providers)) {
      const entry = readEntry(value)
      if (id !== '' && entry !== undefined) providers[id] = entry
    }
    return { version: HEAVY_LIFECYCLE_VERSION, providers }
  } catch {
    return { version: HEAVY_LIFECYCLE_VERSION, providers: {} }
  }
}

/** What one per-provider file says, including the tombstone and malformed cases. */
type ProviderRecord =
  | { readonly kind: 'missing' }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'entry'; readonly entry: HeavyLifecycleEntry }

/** Read one per-provider record; a present but malformed file never falls back. */
function readProviderRecord(dshHome: string, id: string): ProviderRecord {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(providerLifecyclePath(dshHome, id), 'utf8'))
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' }
  }
  if (!isRecord(raw) || raw.version !== HEAVY_LIFECYCLE_VERSION || raw.id !== id) return { kind: 'invalid' }
  if (raw.cleared === true) return { kind: 'cleared' }
  const entry = readEntry(raw)
  return entry === undefined ? { kind: 'invalid' } : { kind: 'entry', entry }
}

/**
 * Read every provider's lifecycle facts: per-provider files first, with the
 * legacy aggregate only for ids that have no per-provider file. A tombstone
 * or malformed per-provider file shadows the aggregate entry.
 * @param dshHome - the DSH home directory.
 * @returns the merged, sanitized lifecycle document.
 */
export function readHeavyLifecycle(dshHome: string): HeavyLifecycleDocument {
  const providers = readLegacyAggregate(dshHome).providers
  let names: string[]
  try {
    names = readdirSync(heavyLifecycleDirectory(dshHome))
  } catch {
    return { version: HEAVY_LIFECYCLE_VERSION, providers }
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let id: string
    try {
      id = decodeURIComponent(name.slice(0, -'.json'.length))
    } catch {
      continue
    }
    if (id === '') continue
    const record = readProviderRecord(dshHome, id)
    if (record.kind === 'entry') providers[id] = record.entry
    else if (record.kind === 'cleared' || record.kind === 'invalid') delete providers[id]
  }
  return { version: HEAVY_LIFECYCLE_VERSION, providers }
}

/**
 * One provider's lifecycle facts, or undefined when legacy/missing state makes
 * it unknown.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 * @returns the sanitized entry, or undefined.
 */
export function lifecycleOf(dshHome: string, id: string): HeavyLifecycleEntry | undefined {
  const local = readProviderRecord(dshHome, id)
  if (local.kind === 'entry') return local.entry
  if (local.kind !== 'missing') return undefined
  return readLegacyAggregate(dshHome).providers[id]
}

/**
 * Whether a lifecycle entry grants authority to run the manifest's static
 * teardown: a local install with `installedByHarness` and a receipt. A reused
 * instance and every unknown record refuse.
 * @param entry - the provider's lifecycle entry, when any.
 * @returns true only for an owned local install with a receipt.
 */
export function ownsLocalInstall(entry: HeavyLifecycleEntry | undefined): boolean {
  return entry !== undefined
    && entry.mode === 'local'
    && entry.installedByHarness
    && entry.receipt !== undefined
    && entry.receipt.length > 0
}

/** Serialize one lifecycle record atomically into its provider file. */
function persist(path: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`
  try {
    writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Commit one provider's lifecycle entry to its own file. Callers hold the
 * provider's job lock, so a concurrent removal or install cannot interleave.
 * Clearing writes a tombstone; the legacy aggregate is never modified.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 * @param entry - the entry to store, or null to clear it.
 * @param now - clock seam for the recorded update time.
 */
export function writeProviderLifecycle(
  dshHome: string,
  id: string,
  entry: Omit<HeavyLifecycleEntry, 'updatedAt'> | null,
  now: () => number = Date.now,
): void {
  const path = providerLifecyclePath(dshHome, id)
  persist(
    path,
    entry === null
      ? { version: HEAVY_LIFECYCLE_VERSION, id, cleared: true }
      : { version: HEAVY_LIFECYCLE_VERSION, id, ...entry, updatedAt: now() },
  )
}

/**
 * Record a successful route-only reuse. Ownership is always false: a detected
 * instance belongs to the operator, not this harness.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 * @param options - optional setup provenance and configured endpoint.
 */
export function recordReuseLifecycle(
  dshHome: string,
  id: string,
  options?: { setupKind?: 'detected-instance' | 'custom-instance'; endpoint?: string },
): void {
  writeProviderLifecycle(dshHome, id, {
    mode: 'reuse',
    installedByHarness: false,
    ...options?.setupKind ? { setupKind: options.setupKind } : {},
    ...options?.endpoint ? { endpoint: options.endpoint } : {},
  })
}

/**
 * Record a local install this harness owns. Internal host API called only
 * after the trusted installer returns its validated receipt; never exposed to
 * the browser. A blank receipt is refused instead of being recorded as
 * ownership.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 * @param receipt - bounded opaque ownership receipt returned by the installer.
 * @param options - optional setup provenance and configured endpoint.
 */
export function registerInstallOwnership(
  dshHome: string,
  id: string,
  receipt: string,
  options?: { setupKind?: 'harness-install'; endpoint?: string },
): void {
  const trimmed = receipt.trim()
  if (trimmed === '') throw new Error('heavy-provider ownership receipt is empty')
  if (trimmed.length > MAX_RECEIPT_CHARS) throw new Error('heavy-provider ownership receipt is too long')
  writeProviderLifecycle(dshHome, id, {
    mode: 'local',
    installedByHarness: true,
    receipt: trimmed,
    setupKind: options?.setupKind ?? 'harness-install',
    ...options?.endpoint ? { endpoint: options.endpoint } : {},
  })
}

/**
 * Clear one provider's lifecycle record by writing its tombstone file.
 * @param dshHome - the DSH home directory.
 * @param id - provider id.
 */
export function clearProviderLifecycle(dshHome: string, id: string): void {
  writeProviderLifecycle(dshHome, id, null)
}

/**
 * Whether a wire receipt is non-empty and within the bounded proof length.
 * @param receipt - the installer-provided ownership proof.
 * @returns true when the receipt may be persisted.
 */
export function isLifecycleReceipt(receipt: string): boolean {
  const trimmed = receipt.trim()
  return trimmed !== '' && trimmed.length <= MAX_RECEIPT_CHARS
}
