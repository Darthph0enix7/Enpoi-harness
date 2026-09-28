/**
 * Client half of the `enpoiHeavy` Remote namespace (the profile plugin
 * `dsh-enpoi-heavy-providers`). Same POST-per-method envelope the fork's
 * `enpoiUiState`/`enpoiGit` calls use; results are business values or a
 * displayable failure message, never thrown.
 *
 * @module ui-settings-models/heavy-rpc
 */

/** One HTTP probe result as the host reports it. */
export interface HeavyHealthView {
  ok: boolean
  status?: number
  error?: string
  checkedAt: number
}

/** One install/teardown job snapshot. */
export interface HeavyJobView {
  id: string
  kind: 'install' | 'teardown'
  state: 'running' | 'succeeded' | 'failed'
  stage: string
  stageIndex: number
  stageCount: number
  pct: number
  logTail: string
  startedAt: number
  finishedAt?: number
  error?: string
}

/** One route profile the host wrote. */
export interface HeavyRouteView {
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv?: string
  keyless?: boolean
  models: Array<{ id: string; name?: string }>
}

/** `enpoiHeavy.status` result. */
export interface HeavyStatusView {
  id: string
  configured: boolean
  mode?: 'reuse' | 'local'
  health: HeavyHealthView
  /** The host platform installs execute on (`process.platform`). */
  platform?: string
  unsupported?: { reason: string; plannedWith: string; reuseUrl: string }
  job?: HeavyJobView
}

/** `enpoiHeavy.reuse` result. */
export interface HeavyReuseView {
  ok: boolean
  blocked?: { reason: string; plannedWith: string }
  route?: HeavyRouteView
  health?: HeavyHealthView
  models?: Array<{ id: string; name?: string }>
  credentialStored?: boolean
}

/** `enpoiHeavy.install` result. */
export interface HeavyInstallView {
  ok: boolean
  blocked?: { reason: string; plannedWith: string }
  job?: HeavyJobView
}

/** `enpoiHeavy.remove` result. */
export interface HeavyRemoveView {
  ok: boolean
  summary?: {
    routeRemoved: boolean
    credentialRemoved: boolean
    poolStateRemoved: boolean
    cacheEntryRemoved: boolean
    chainLinksRemoved: number
    teardown: { ran: boolean; ok: boolean; failedStep?: string; output: string }
    errors: string[]
  }
}

/** One `enpoiHeavy.*` call's outcome. */
export type HeavyRpcResult<T> = { ok: true; value: T } | { ok: false; message: string }

let sequence = 0

/**
 * One call over the shared client-request envelope.
 * @param method - remote endpoint (`enpoiHeavy.status`, `enpoiHeavy.install`, …).
 * @param args - exact wire arguments keyed by the host method's parameter name
 *   (`{ request }` for the one-argument methods; `{}` for `manifests`).
 * @returns the business value or a displayable failure message.
 */
export async function heavyRpc<T>(method: string, args: Record<string, unknown>): Promise<HeavyRpcResult<T>> {
  try {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: `${method}-${sequence += 1}`,
        payload: { args },
      }),
    })
    if (!response.ok) return { ok: false, message: `gateway responded ${response.status}` }
    const json = await response.json() as {
      result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } }
    }
    const result = json.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'heavy provider request was rejected' }
    }
    return { ok: true, value: result.value as T }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** The `enpoiHeavy.*` calls the Models page makes. */
export const heavyApi = {
  /** Fetch the host's manifest table (display copy; listing is static). */
  manifests: () => heavyRpc<{ items: unknown[]; problems: string[]; platform?: string }>('enpoiHeavy.manifests', {}),
  /** Configured/health/job state for one provider. */
  status: (id: string) => heavyRpc<HeavyStatusView>('enpoiHeavy.status', { request: { id } }),
  /** Add by reuse: probe the server endpoint, write the route. */
  reuse: (id: string, key?: string) => heavyRpc<HeavyReuseView>('enpoiHeavy.reuse', { request: { id, ...key === undefined || key === '' ? {} : { key } } }),
  /** Add by local install: start the polled job. */
  install: (id: string, key?: string) => heavyRpc<HeavyInstallView>('enpoiHeavy.install', { request: { id, ...key === undefined || key === '' ? {} : { key } } }),
  /** Poll one provider's current job. */
  job: (id: string) => heavyRpc<{ job?: HeavyJobView }>('enpoiHeavy.job', { request: { id } }),
  /** Remove the provider (optionally running the local teardown first). */
  remove: (id: string, uninstall: boolean) => heavyRpc<HeavyRemoveView>('enpoiHeavy.remove', { request: { id, uninstall } }),
}

/**
 * Poll a running install job until it settles.
 * @param id - provider id.
 * @param onUpdate - observer for every snapshot (the progress bar).
 * @param options - poll cadence and overall bound.
 * @returns the settled snapshot, or a failed snapshot carrying the reason.
 */
export async function pollHeavyJob(
  id: string,
  onUpdate: (job: HeavyJobView) => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<HeavyJobView | null> {
  const interval = options.intervalMs ?? 1000
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000)
  for (;;) {
    const result = await heavyApi.job(id)
    if (result.ok) {
      const job = result.value.job
      if (job !== undefined) {
        onUpdate(job)
        if (job.state !== 'running') return job
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

/** Status/health cache lifetime: a mounted page probes each provider at most once per minute. */
export const HEAVY_HEALTH_TTL_MS = 60_000

/** Install-job poll cadence: fast enough to animate progress, far from a tight loop. */
export const HEAVY_JOB_POLL_MS = 2000

/** One cached status snapshot and the clock reading it was stored at. */
interface HeavyStatusEntry {
  at: number
  value: HeavyStatusView
}

/** The TTL cache behind the ONLINE indicators. */
export interface HeavyStatusCache {
  /** The fresh cached snapshot, or undefined when absent or expired. */
  peek(id: string): HeavyStatusView | undefined
  /** Read through the cache; concurrent callers share one in-flight load. */
  read(id: string, options?: { force?: boolean }): Promise<HeavyRpcResult<HeavyStatusView>>
  /** Drop one provider's entry, or every entry. */
  invalidate(id?: string): void
}

/**
 * Create a status cache. Fail-soft: a failed load is reported to its caller
 * and stores nothing, so the previous snapshot (if any) stays displayable and
 * a refused probe never becomes a page error.
 * @param options - TTL, clock, and loader seams.
 * @returns the cache handle.
 */
export function createHeavyStatusCache(options: {
  ttlMs?: number
  now?: () => number
  load?: (id: string) => Promise<HeavyRpcResult<HeavyStatusView>>
} = {}): HeavyStatusCache {
  const ttlMs = options.ttlMs ?? HEAVY_HEALTH_TTL_MS
  const now = options.now ?? Date.now
  const load = options.load ?? ((id: string) => heavyApi.status(id))
  const entries = new Map<string, HeavyStatusEntry>()
  const inflight = new Map<string, Promise<HeavyRpcResult<HeavyStatusView>>>()
  return {
    peek: (id) => {
      const entry = entries.get(id)
      return entry === undefined || now() - entry.at >= ttlMs ? undefined : entry.value
    },
    read: (id, readOptions) => {
      const entry = entries.get(id)
      if (readOptions?.force !== true && entry !== undefined && now() - entry.at < ttlMs) {
        return Promise.resolve({ ok: true, value: entry.value })
      }
      const pending = inflight.get(id)
      if (pending !== undefined) return pending
      const request = load(id)
        .then(
          (result) => {
            if (result.ok) entries.set(id, { at: now(), value: result.value })
            return result
          },
          (error: unknown): HeavyRpcResult<HeavyStatusView> => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => { inflight.delete(id) })
      inflight.set(id, request)
      return request
    },
    invalidate: (id) => {
      if (id === undefined) entries.clear()
      else entries.delete(id)
    },
  }
}

/** The page-wide status cache shared by the provider list and the detail card. */
export const heavyStatusCache = createHeavyStatusCache()
