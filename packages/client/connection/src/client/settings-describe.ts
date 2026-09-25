/**
 * Shared coalesced `settings.describe` reader.
 *
 * The settings document fans out to many client stores (settings mirror, model
 * picker, hidden-surface and enpoi namespace caches), and each one used to POST
 * the same 546 KB describe on its own. This module is installed once by the
 * browser wire root under {@link SETTINGS_DESCRIBE_GLOBAL}, so every store in
 * every plugin bundle consumes one shared read:
 *
 * - concurrent callers inside the debounce window fold into one request
 *   (single in-flight promise, pre-merge pattern);
 * - a read that answered within {@link FRESH_MS} is reused without a request;
 * - the ETag of the last answer is sent back as `If-None-Match`, so a repeat
 *   read the Host still holds returns a bodiless `304` and the cached answer.
 *
 * A store that must not import the wire package reads the same function off the
 * page global; when the global is absent (standalone tests, non-wire carriers)
 * callers keep their own transport.
 */

/** One namespace row of a describe answer, structural subset. */
export interface SettingsDescribeNamespace {
  ns?: unknown
  value?: unknown
  user?: unknown
  revision?: unknown
}

/** The successful describe value: every registered namespace view. */
export interface SettingsDescribeValue {
  namespaces: readonly SettingsDescribeNamespace[]
  writable?: unknown
}

/** Page global holding {@link readSettingsDescribe}; the cross-bundle seam. */
export const SETTINGS_DESCRIBE_GLOBAL = '__dshSettingsDescribe'

/** Session-storage key of the last answer, so a warm reload can send `If-None-Match`. */
const CACHE_KEY = 'dsh.settings.describe'

/** Burst window: callers landing inside it share one request. */
const DEBOUNCE_MS = 25

/** A read this recent answers later callers without touching the wire. */
const FRESH_MS = 250

/** Route the server normalizes to the `settings/describe` endpoint. */
const DESCRIBE_ROUTE = '/api/settings.describe'

/** The boot reveal gate's advertised-worker face, when a page kernel installed one. */
interface BootGateFace {
  expect?: (name: string) => void
  register?: (name: string, promise: Promise<unknown>) => void
}

function bootGate(): BootGateFace | undefined {
  return (globalThis as { __dshBootGate?: BootGateFace }).__dshBootGate
}

/** Restore the previous page's answer so its ETag can turn the first read into a 304. */
function restoreCachedAnswer(): void {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (raw === null) return
    const stored = JSON.parse(raw) as { etag?: unknown; value?: unknown }
    if (typeof stored.etag !== 'string' || typeof stored.value !== 'object' || stored.value === null) return
    const value = stored.value as SettingsDescribeValue
    if (!Array.isArray(value.namespaces)) return
    etag = stored.etag
    cached = value
    // Stale by construction: the first read revalidates through If-None-Match.
    cachedAt = 0
  } catch {
    // Storage unavailable or the record is malformed: start cold.
  }
}

/** Keep the answer for the next reload; storage failures only cost a full read. */
function persistCachedAnswer(value: SettingsDescribeValue): void {
  if (etag === undefined) return
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ etag, value }))
  } catch {
    // Quota or disabled storage: the in-memory cache still serves this page.
  }
}

/** Transport signature shared with the wire caller. */
export type SettingsDescribeFetch = (input: string | URL, init: RequestInit) => Promise<Response>

let configured: SettingsDescribeFetch | undefined
let etag: string | undefined
let cached: SettingsDescribeValue | undefined
let cachedAt = 0
let inFlight: Promise<SettingsDescribeValue | undefined> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let waiters: Array<(value: SettingsDescribeValue | undefined) => void> = []
let seq = 0

restoreCachedAnswer()

/** Resolve every caller waiting on the current burst. */
function settle(value: SettingsDescribeValue | undefined): void {
  const pending = waiters
  waiters = []
  for (const resolve of pending) resolve(value)
}

/** One request, conditional on the last answer's ETag; `304` reuses the cache. */
async function requestDescribe(send: SettingsDescribeFetch): Promise<SettingsDescribeValue | undefined> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (etag !== undefined) headers['if-none-match'] = etag
  try {
    const response = await send(DESCRIBE_ROUTE, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `shared-describe-${seq += 1}`,
        method: 'settings.describe',
        payload: { args: {} },
      }),
    })
    if (response.status === 304) {
      // The body is unchanged as of now, so later callers can share this answer.
      cachedAt = Date.now()
      return cached
    }
    if (!response.ok) return undefined
    const json: unknown = await response.json()
    const result = (json as { result?: { ok?: boolean; value?: unknown } } | null)?.result
    if (result?.ok !== true || typeof result.value !== 'object' || result.value === null) return undefined
    const value = result.value as SettingsDescribeValue
    if (!Array.isArray(value.namespaces)) return undefined
    etag = response.headers.get('etag') ?? undefined
    cached = value
    cachedAt = Date.now()
    persistCachedAnswer(value)
    return value
  } catch {
    // Offline or malformed answer: callers keep their last snapshot.
    return undefined
  }
}

/** Fire the shared request after the burst window closes. */
function flush(): void {
  timer = undefined
  const send = configured
  if (send === undefined) {
    settle(undefined)
    return
  }
  const run = requestDescribe(send)
  inFlight = run
  bootGate()?.register?.('settings', run)
  void run.then((value) => {
    if (inFlight === run) inFlight = undefined
    settle(value)
  })
}

/**
 * Read every namespace through one coalesced request.
 * @returns the shared describe value, or undefined when no answer landed.
 */
export function readSettingsDescribe(): Promise<SettingsDescribeValue | undefined> {
  if (inFlight !== undefined) return inFlight
  if (cached !== undefined && Date.now() - cachedAt < FRESH_MS) return Promise.resolve(cached)
  if (timer === undefined) timer = setTimeout(flush, DEBOUNCE_MS)
  return new Promise((resolve) => { waiters.push(resolve) })
}

/**
 * Publish the coalesced reader on the page global for plugin bundles that must
 * not import the wire package. Later installs (a replacement transport) take
 * over the shared slot.
 * @param send - transport the reader posts through.
 * @returns the installed reader.
 */
export function installSettingsDescribe(send: SettingsDescribeFetch): () => Promise<SettingsDescribeValue | undefined> {
  configured = send
  bootGate()?.expect?.('settings')
  ;(globalThis as Record<string, unknown>)[SETTINGS_DESCRIBE_GLOBAL] = readSettingsDescribe
  return readSettingsDescribe
}

/**
 * The reader another bundle installed, if any.
 * @returns the shared reader, or undefined when no wire root has run.
 */
export function sharedSettingsDescribe(): (() => Promise<SettingsDescribeValue | undefined>) | undefined {
  const candidate = (globalThis as Record<string, unknown>)[SETTINGS_DESCRIBE_GLOBAL]
  return typeof candidate === 'function'
    ? candidate as () => Promise<SettingsDescribeValue | undefined>
    : undefined
}
