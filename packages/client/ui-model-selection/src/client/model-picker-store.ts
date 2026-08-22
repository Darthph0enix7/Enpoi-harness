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

/** Check if a group is collapsed. */
export function isGroupCollapsed(groupId: string): boolean {
  const collapsed = safeGetJson<string[]>(KEY_COLLAPSED_GROUPS, [])
  return collapsed.includes(groupId)
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

/** Format context tokens compactly (e.g. 1M, 128K, 1.05M). */
export function formatCompactContext(tokens?: number): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return val % 1 === 0 ? `${val}M` : `${val.toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (tokens >= 1000) {
    const val = Math.round(tokens / 1000)
    return `${val}K`
  }
  return `${tokens}`
}
