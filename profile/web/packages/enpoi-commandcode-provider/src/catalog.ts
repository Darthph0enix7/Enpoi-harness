/**
 * Command Code model catalog: the single source of capabilities.
 *
 * Vision flags, reasoning-effort names, plan badges (`[Go+]`, `[Pro+]`,
 * `[Max]`), context windows, and variants are read from the keypool-served
 * `/catalog.json` — never hard-coded — so a model added upstream appears
 * without a package release. The live fetch at startup falls back to the
 * bundled snapshot (data, not code) when the keypool is unreachable.
 *
 * @module dsh-enpoi-commandcode-provider/catalog
 */

/** One catalog model entry (the keypool master catalog's fields). */
export interface CatalogEntry {
  id: string
  name: string
  tier?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
  reasoningEfforts?: string[]
  variants?: Record<string, unknown>
  cost?: Record<string, number>
  limit?: { context?: number; output?: number }
}

/** Normalize a parsed catalog into entries; tolerates an array or an id-keyed object. */
export function parseCatalog(raw: unknown): CatalogEntry[] {
  const rows = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>)
  const entries: CatalogEntry[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    entries.push({
      id: record.id,
      name: typeof record.name === 'string' && record.name !== '' ? record.name : record.id,
      ...typeof record.tier === 'string' ? { tier: record.tier } : {},
      ...typeof record.reasoning === 'boolean' ? { reasoning: record.reasoning } : {},
      ...typeof record.tool_call === 'boolean' ? { tool_call: record.tool_call } : {},
      ...typeof record.attachment === 'boolean' ? { attachment: record.attachment } : {},
      ...typeof record.modalities === 'object' && record.modalities !== null
        ? { modalities: record.modalities as CatalogEntry['modalities'] }
        : {},
      ...Array.isArray(record.reasoningEfforts)
        ? { reasoningEfforts: record.reasoningEfforts.filter((effort): effort is string => typeof effort === 'string') }
        : {},
      ...typeof record.variants === 'object' && record.variants !== null
        ? { variants: record.variants as Record<string, unknown> }
        : {},
      ...typeof record.cost === 'object' && record.cost !== null
        ? { cost: record.cost as Record<string, number> }
        : {},
      ...typeof record.limit === 'object' && record.limit !== null
        ? { limit: record.limit as CatalogEntry['limit'] }
        : {},
    })
  }
  return entries
}

/** Find one entry by exact id, then by short (vendor-stripped) id. */
export function entryFor(entries: readonly CatalogEntry[], modelId: string): CatalogEntry | undefined {
  const exact = entries.find(entry => entry.id === modelId)
  if (exact !== undefined) return exact
  const short = modelId.split('/').pop() ?? modelId
  return entries.find(entry => entry.id === short || entry.id.split('/').pop() === short)
}

/**
 * Whether one catalog entry accepts image input. Unknown entries are
 * permissive: forwarding an image can at worst be rejected upstream, while
 * omitting it silently loses information.
 */
export function visionOf(entry: CatalogEntry | undefined): boolean {
  if (entry === undefined) return true
  if (entry.attachment === true) return true
  const inputs = entry.modalities?.input
  if (Array.isArray(inputs) && inputs.length > 0) return inputs.includes('image')
  return true
}

/** Declared input modalities, or undefined when the catalog says nothing. */
export function modalitiesOf(entry: CatalogEntry | undefined): ('text' | 'image')[] | undefined {
  const inputs = entry?.modalities?.input
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined
  return inputs.filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
}

/**
 * Selectable reasoning efforts for one entry, names exactly as the catalog
 * spells them. A non-reasoning model has none; a reasoning model with no
 * list gets none (absence means the provider's own default).
 */
export function effortsOf(entry: CatalogEntry | undefined): string[] {
  if (entry?.reasoning !== true) return []
  return entry.reasoningEfforts ?? []
}

/** The context window the catalog declares, when it does. */
export function contextWindowOf(entry: CatalogEntry | undefined): number | undefined {
  const context = entry?.limit?.context
  return typeof context === 'number' && context > 0 ? context : undefined
}

/** The plan badge embedded in a catalog display name (`[Go+]`, `[Pro+]`, `[Max]`). */
export function planBadgeOf(entry: CatalogEntry | undefined): string | undefined {
  const match = /\[[^\]]+\]\s*$/.exec(entry?.name ?? '')
  return match?.[0]
}

/** One catalog source: the live keypool endpoint or the bundled snapshot. */
export type CatalogSource = 'live' | 'snapshot'

/** Options for {@link CatalogStore}. */
export interface CatalogStoreOptions {
  /** Route base URL, e.g. `http://127.0.0.1:8899/commandcode`. */
  baseURL: string
  /** Bundled snapshot entries used when the live fetch fails. */
  snapshot: readonly CatalogEntry[]
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Live-fetch timeout; defaults to 5 s. */
  timeoutMs?: number
}

/**
 * Startup catalog loader: one fetch per route, cached. `start()` is fire and
 * forget (the plugin's apply does not block the boot); readers await
 * `entries()`, which resolves from the live catalog or the snapshot.
 */
export class CatalogStore {
  private pending: Promise<CatalogEntry[]> | undefined
  private resolved: CatalogEntry[] | undefined
  private origin: CatalogSource = 'snapshot'

  constructor(private readonly options: CatalogStoreOptions) {}

  /** Kick the live fetch; safe to call once per route. */
  start(): void {
    void this.load().catch(() => undefined)
  }

  /** The catalog entries, fetching once on first demand. */
  async entries(): Promise<readonly CatalogEntry[]> {
    return await this.load()
  }

  /** Which source served the current entries. */
  source(): CatalogSource {
    return this.origin
  }

  private load(): Promise<CatalogEntry[]> {
    if (this.resolved !== undefined) return Promise.resolve(this.resolved)
    this.pending ??= this.fetchLive().then((entries) => {
      this.resolved = entries
      this.origin = 'live'
      return entries
    }).catch(() => {
      this.resolved = [...this.options.snapshot]
      this.origin = 'snapshot'
      return this.resolved
    })
    return this.pending
  }

  private async fetchLive(): Promise<CatalogEntry[]> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    const url = `${this.options.baseURL.replace(/\/+$/, '')}/catalog.json`
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    })
    if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${String(response.status)}`)
    const entries = parseCatalog(JSON.parse(await response.text()) as unknown)
    if (entries.length === 0) throw new Error('catalog fetch returned no models')
    return entries
  }
}
