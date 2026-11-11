/**
 * Model Picker Persistent Preferences Store (OpenChamber Model Picker UX)
 * Manages favorites, recents, provider ordering, and collapsed groups.
 */

const KEY_FAVORITES = 'dsh_model_favorites_v2'
const KEY_RECENTS = 'dsh_model_recents_v2'
const KEY_PROVIDER_ORDER = 'dsh_provider_order_v2'
const KEY_COLLAPSED_GROUPS = 'dsh_collapsed_groups_v2'

export interface ModelRef {
  provider: string
  modelId: string
}

function safeGetJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function safeSetJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    window.dispatchEvent(new CustomEvent('dsh:model-picker-prefs-changed', { detail: { key } }))
  } catch {
    // Local storage disabled or quota exceeded
  }

  // Cross-device server persistence for favorites and provider ordering
  if (key === KEY_FAVORITES || key === KEY_PROVIDER_ORDER) {
    const prefField = key === KEY_FAVORITES ? 'favorites' : 'providerOrder'
    void fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: `sync-${prefField}`,
        payload: {
          args: {
            ns: 'enpoi-orchestration',
            ops: [{ op: 'set', path: ['uiPreferences', prefField], value }],
          },
        },
      }),
    }).catch(() => {})
  }
}

// Global server sync on module import: pulls cross-device preferences without blocking local 0ms render
if (typeof window !== 'undefined') {
  const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  const readNamespaces = async (): Promise<unknown> => {
    if (typeof shared === 'function') {
      return (await (shared as () => Promise<{ namespaces?: unknown } | undefined>)())?.namespaces
    }
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: 'prime-picker-prefs',
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json: unknown = await res.json()
    return (json as { result?: { value?: { namespaces?: unknown } } } | null)?.result?.value?.namespaces
  }
  void readNamespaces()
    .then((namespaces) => {
      const orch = Array.isArray(namespaces)
        ? (namespaces as Array<{ ns?: string; value?: { uiPreferences?: { favorites?: ModelRef[]; providerOrder?: string[] } }; user?: { uiPreferences?: { favorites?: ModelRef[]; providerOrder?: string[] } } }>).find(n => n.ns === 'enpoi-orchestration')
        : undefined
      const prefs = orch?.value?.uiPreferences ?? orch?.user?.uiPreferences
      if (prefs?.favorites && Array.isArray(prefs.favorites)) {
        localStorage.setItem(KEY_FAVORITES, JSON.stringify(prefs.favorites))
        window.dispatchEvent(new CustomEvent('dsh:model-picker-prefs-changed', { detail: { key: KEY_FAVORITES } }))
      }
      if (prefs?.providerOrder && Array.isArray(prefs.providerOrder)) {
        localStorage.setItem(KEY_PROVIDER_ORDER, JSON.stringify(prefs.providerOrder))
        window.dispatchEvent(new CustomEvent('dsh:model-picker-prefs-changed', { detail: { key: KEY_PROVIDER_ORDER } }))
      }
    })
    .catch(() => {})
}

/** Check if a model is favorited. */
export function isModelFavorite(provider: string, modelId: string): boolean {
  const favorites = safeGetJson<ModelRef[]>(KEY_FAVORITES, [])
  return favorites.some(f => f.provider === provider && f.modelId === modelId)
}

/** Toggle favorite on/off. */
export function toggleModelFavorite(provider: string, modelId: string): boolean {
  const favorites = safeGetJson<ModelRef[]>(KEY_FAVORITES, [])
  const idx = favorites.findIndex(f => f.provider === provider && f.modelId === modelId)
  let isFav = false
  if (idx >= 0) {
    favorites.splice(idx, 1)
    isFav = false
  } else {
    favorites.push({ provider, modelId })
    isFav = true
  }
  safeSetJson(KEY_FAVORITES, favorites)
  return isFav
}

/** Get list of favorite models. */
export function getFavoriteModels(): ModelRef[] {
  return safeGetJson<ModelRef[]>(KEY_FAVORITES, [])
}

/** Reorder favorite models. */
export function setFavoriteModels(favorites: ModelRef[]): void {
  safeSetJson(KEY_FAVORITES, favorites)
}

/** Get recent models list (up to 6). */
export function getRecentModels(): ModelRef[] {
  return safeGetJson<ModelRef[]>(KEY_RECENTS, [])
}

/** Record a recent model usage. */
export function recordRecentModel(provider: string, modelId: string): void {
  let recents = safeGetJson<ModelRef[]>(KEY_RECENTS, [])
  recents = recents.filter(r => !(r.provider === provider && r.modelId === modelId))
  recents.unshift({ provider, modelId })
  if (recents.length > 6) recents = recents.slice(0, 6)
  safeSetJson(KEY_RECENTS, recents)
}

/** Get custom provider order. */
export function getProviderOrder(): string[] {
  return safeGetJson<string[]>(KEY_PROVIDER_ORDER, [])
}

/** Set custom provider order. */
export function setProviderOrder(order: string[]): void {
  safeSetJson(KEY_PROVIDER_ORDER, order)
}

/** Toggle group collapse state. */
export function toggleGroupCollapsed(groupId: string): boolean {
  const collapsed = safeGetJson<string[]>(KEY_COLLAPSED_GROUPS, [])
  const idx = collapsed.indexOf(groupId)
  let isNowCollapsed = false
  if (idx >= 0) {
    collapsed.splice(idx, 1)
    isNowCollapsed = false
  } else {
    collapsed.push(groupId)
    isNowCollapsed = true
  }
  safeSetJson(KEY_COLLAPSED_GROUPS, collapsed)
  return isNowCollapsed
}

/** Catalog facts a picker row renders as capability tags. */
export interface ModelContextTarget {
  id: string
  contextWindow?: number | undefined
  /** Provenance of `contextWindow`; `default` names a route fallback, not a disclosed capacity. */
  contextWindowSource?: 'configured' | 'discovered' | 'installed' | 'default' | undefined
  maxInputTokens?: number | undefined
  /** Provenance of `maxInputTokens`; `default` names a route fallback, not a disclosed capacity. */
  maxInputTokensSource?: 'configured' | 'discovered' | 'installed' | 'default' | undefined
  context?: { contextWindow?: number | undefined; maxInputTokens?: number | undefined } | undefined
  maxTokens?: number | undefined
  /** Whether the catalog could not verify this row's facts. */
  unverified?: boolean | undefined
  /** Effective request input modalities; absent means unknown. */
  inputModalities?: readonly string[] | undefined
  /** Advertised input modalities, including tokens no native request encoding sends. */
  advertisedInputModalities?: readonly string[] | undefined
}

/**
 * Resolve context window size in tokens from disclosed catalog fields only;
 * falls back to disclosed prompt-input cap (`maxInputTokens`) when combined
 * context window is omitted (e.g. Anthropic / Gemini endpoints); an undisclosed
 * window returns 0 so the picker renders no capacity.
 * @param model - catalog row whose context capacity is displayed.
 * @returns the disclosed window or input cap size, or 0 when no field states one.
 */
export function resolveContextTokens(model: ModelContextTarget): number {
  const disclosedContext = model.contextWindowSource !== 'default'
    ? (typeof model.contextWindow === 'number' && model.contextWindow > 0
      ? model.contextWindow
      : typeof model.context?.contextWindow === 'number' && model.context.contextWindow > 0
        ? model.context.contextWindow
        : undefined)
    : undefined
  if (disclosedContext !== undefined) return disclosedContext

  const disclosedInput = model.maxInputTokensSource !== 'default'
    ? (typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0
      ? model.maxInputTokens
      : typeof model.context?.maxInputTokens === 'number' && model.context.maxInputTokens > 0
        ? model.context.maxInputTokens
        : undefined)
    : undefined
  if (disclosedInput !== undefined) return disclosedInput

  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    return model.contextWindow
  }
  const rawContext = model.context?.contextWindow
  if (typeof rawContext === 'number' && rawContext > 0) {
    return rawContext
  }
  if (typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0) {
    return model.maxInputTokens
  }
  const rawInput = model.context?.maxInputTokens
  if (typeof rawInput === 'number' && rawInput > 0) {
    return rawInput
  }
  return 0
}

/** Modalities an advertised catalog never encodes in a native request. */
const DISCLOSURE_ONLY_MODALITIES: ReadonlySet<string> = new Set(['audio', 'video', 'pdf'])

/**
 * Disclosure-side modalities the adapter does not send in a native request.
 * Text and image stay out of this set: an absent effective list means unknown,
 * not that the adapter refuses them.
 * @param model - catalog row carrying effective and advertised modality lists.
 * @returns advertised audio/video/pdf tokens absent from the effective list.
 */
export function advertisedOnlyModalities(
  model: Pick<ModelContextTarget, 'inputModalities' | 'advertisedInputModalities'>,
): readonly string[] {
  const effective = new Set(model.inputModalities ?? [])
  return (model.advertisedInputModalities ?? [])
    .filter(modality => DISCLOSURE_ONLY_MODALITIES.has(modality) && !effective.has(modality))
}

/** Format context tokens compactly (e.g. 1M, 128K, 1.05M). */
export function formatCompactContext(tokens?: number): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return val % 1 === 0 ? `${val}M` : `${val.toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (tokens >= 1000) {
    // Never round a disclosed capacity upward: 65,536 is 65K, not 66K.
    const val = Math.floor(tokens / 1000)
    return `${val}K`
  }
  return `${tokens}`
}
