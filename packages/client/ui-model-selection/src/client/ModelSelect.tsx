/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * OpenChamber-style Model Picker & Input Card design:
 * - Trigger Bar: Clean Model Button (opens picker popover directly) + Conditional Reasoning Effort Pill.
 * - Model Picker Popover:
 *   - Search Bar for instant filtering across all providers.
 *   - Collapsible Favorites group with manual drag-and-drop reordering.
 *   - Collapsible Recent group with last used models.
 *   - Collapsible Provider groups with 6-dot drag handles to rearrange provider ordering.
 *   - Clean model rows: only human-readable Model Name + compact gray context size (e.g. 1M, 128K) + Star toggle.
 *   - Rule-aware visibility: entries the host rules engine hides carry their
 *     reason when the search asks for them; a manual shown pin that overrode a
 *     hide rule shows the rule it beat.
 *   - Pure monochrome vector icons throughout.
 *   - Input-matching glass material & border tokens.
 *
 * Data and submission ride the SAME per-session ModelDirectory as the /model
 * popup, and a pick reflects immediately (0ms) while the Host answer settles.
 * A rejected selection announces through the shared transient Toast anchored
 * to the composer card.
 *
 * @module dsh-client-ui-model-selection/ModelSelect
 */

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type DragEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Sheet, Toast, useSheetPresentation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import {
  isModelFavorite, toggleModelFavorite, getFavoriteModels, setFavoriteModels,
  getRecentModels, recordRecentModel, getProviderOrder, setProviderOrder,
  toggleGroupCollapsed, formatCompactContext, resolveContextTokens,
  type ModelContextTarget,
} from './model-picker-store.ts'
import {
  IconSearch, IconStar, IconClock, IconGrip, IconChevron, IconCheck, IconBrain, IconChain,
} from './icons.tsx'
import {
  MODEL_GROUPS_CHANGED_EVENT, assignableModelGroups, ensureModelGroups, modelGroupById, refreshModelGroups,
} from './model-groups.ts'
import {
  CATALOG_VISIBILITY_CHANGED_EVENT, catalogVisibilitySnapshot, ensureCatalogVisibility,
} from './catalog-visibility.ts'
import css from './ModelSelect.module.css'

/** Cached hidden-map reader for hot render paths: parse once per prefsVersion. */
function readHiddenMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem('dsh_hidden_models_v1')
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string[]>
  } catch { return {} }
}

/**
 * Explicitly-shown-map reader (the Settings page's eye toggle writes it): a
 * model pinned shown must survive rule/gate hiding in the picker, so this map
 * wins over the published decision map. Same 0ms local read as the hidden map.
 */
function readShownMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem('dsh_shown_models_v1')
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string[]>
  } catch { return {} }
}

/** Format the model context window compactly (guaranteed display). */
function resolveModelContext(model: ModelContextTarget): string {
  const tokens = resolveContextTokens(model)
  return formatCompactContext(tokens)
}

/** One dynamic effort choice row. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/**
 * Override face for reusing this picker outside the composer seat (e.g. the
 * Watchtower's per-persona assignments): the active row and label come from
 * the caller, and submits route to the caller instead of session.selectModel.
 * Everything else (directory data, hidden-model filter, favorites, recents,
 * drag ordering, search) behaves identically.
 */
export interface ModelSelectOverride {
  /** The caller's current selection (null = nothing selected yet). */
  current: ModelSelection | null
  /** Submit target for both model and effort choices. */
  select: (selection: ModelSelection) => Promise<boolean>
  /** Optional placeholder when current is null (e.g. "Inherit" or "Auto"). */
  placeholder?: string
}
/** Unplaced portal panel: hidden but laid out so `offsetWidth` is real for the clamp. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * The seat's submit gate. The shared directory reports a RemoteResult; a
 * caller override reports the boolean its own store accepted, so both
 * outcomes settle through one path.
 */
type ModelSelectSubmit = (
  selection: ModelSelection,
) => Promise<RemoteResult<void> | boolean | undefined>

export function ModelSelect(
  { locked, available, directory, load, select, compact, override, t }:
  Omit<ModelSelectInjected, 'select'>
  & { select: ModelSelectSubmit }
  & { locked: boolean; compact?: boolean; override?: ModelSelectOverride }
  & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )

  // The selection this instance highlights and labels: the override's when
  // reused, otherwise the session's own current selection.
  const activeSel = override !== undefined ? override.current : state.current

  const sheetMode = useSheetPresentation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [prefsVersion, setPrefsVersion] = useState(0)
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null)
  const [draggedFavorite, setDraggedFavorite] = useState<number | null>(null)
  const [dragOverItem, setDragOverItem] = useState<string | null>(null)

  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const effortRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)

  // Listen to preference changes across tabs / components
  useEffect(() => {
    const onPrefsChange = () => setPrefsVersion(v => v + 1)
    const onGroupsChange = () => {
      void refreshModelGroups()
      setPrefsVersion(v => v + 1)
    }
    const onRulesChange = () => {
      // The event announces a map that already moved; repaint from the cache
      // instead of re-reading (a re-read here would loop through publish).
      setPrefsVersion(v => v + 1)
    }
    window.addEventListener('dsh:model-picker-prefs-changed', onPrefsChange)
    window.addEventListener('dsh:hidden-models-changed', onPrefsChange)
    window.addEventListener('storage', onPrefsChange)
    window.addEventListener(MODEL_GROUPS_CHANGED_EVENT, onGroupsChange)
    window.addEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, onRulesChange)
    return () => {
      window.removeEventListener('dsh:model-picker-prefs-changed', onPrefsChange)
      window.removeEventListener('dsh:hidden-models-changed', onPrefsChange)
      window.removeEventListener('storage', onPrefsChange)
      window.removeEventListener(MODEL_GROUPS_CHANGED_EVENT, onGroupsChange)
      window.removeEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, onRulesChange)
    }
  }, [])

  // Mount-time load
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  // A picker mounted before the registry's import-time read settled repaints
  // once that read resolves; a later read rides the groups-changed event.
  useEffect(() => {
    let cancelled = false
    void ensureModelGroups().then(() => {
      if (!cancelled) setPrefsVersion(v => v + 1)
    })
    return () => { cancelled = true }
  }, [])

  // The host rules engine's resolved decision map primes the same way.
  useEffect(() => {
    let cancelled = false
    void ensureCatalogVisibility().then(() => {
      if (!cancelled) setPrefsVersion(v => v + 1)
    })
    return () => { cancelled = true }
  }, [])

  // 0ms hot-path caches: parse hidden/shown/collapsed maps once per prefsVersion, not per model
  const hiddenMap = useMemo(() => readHiddenMap(), [prefsVersion])
  const hiddenSets = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [k, v] of Object.entries(hiddenMap)) if (Array.isArray(v)) m.set(k, new Set(v))
    return m
  }, [hiddenMap])
  const isHiddenCached = useMemo(() => {
    return (provider: string, modelId: string) => hiddenSets.get(provider)?.has(modelId) ?? false
  }, [hiddenSets])
  const shownMap = useMemo(() => readShownMap(), [prefsVersion])
  const shownSets = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [k, v] of Object.entries(shownMap)) if (Array.isArray(v)) m.set(k, new Set(v))
    return m
  }, [shownMap])
  const isShownCached = useMemo(() => {
    return (provider: string, modelId: string) => shownSets.get(provider)?.has(modelId) ?? false
  }, [shownSets])
  // Rule decisions ride the same prefsVersion: the localStorage list is the 0ms
  // manual truth, the published map adds hide-rule/gating state (and pins). An
  // explicit local shown pin beats every hiding source, matching the eye.
  const catalogVisibility = useMemo(() => catalogVisibilitySnapshot(), [prefsVersion])
  const decisionFor = useMemo(() => {
    return (provider: string, modelId: string) => catalogVisibility.get(`${provider}/${modelId}`)
  }, [catalogVisibility])
  const isModelHidden = useMemo(() => {
    // Precedence mirrors the rules engine and the settings eye: a manual hidden
    // pin beats a manual shown pin; a shown pin beats the decision map (rules
    // and gating). A model present in both maps therefore stays hidden.
    return (provider: string, modelId: string) =>
      isHiddenCached(provider, modelId)
      || (!isShownCached(provider, modelId) && decisionFor(provider, modelId)?.state === 'hidden')
  }, [isHiddenCached, isShownCached, decisionFor])
  const collapsedSet = useMemo(() => {
    try {
      const raw = localStorage.getItem('dsh_collapsed_groups_v2')
      if (!raw) return new Set<string>()
      const arr = JSON.parse(raw) as string[]
      return new Set(Array.isArray(arr) ? arr : [])
    } catch { return new Set<string>() }
  }, [prefsVersion])

  // Close outside
  useEffect(() => {
    if (!pickerOpen && !effortOpen) return
    // Sheet presentation: the mask, Escape, and the touch back gesture own the
    // dismissal, and the anchored popover's outside-pointer rule would fight
    // the sheet's own pointer handling.
    if (sheetMode) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (pickerOpen && pickerRef.current && !pickerRef.current.contains(target) && !triggerRef.current?.contains(target)) {
        setPickerOpen(false)
        setSearchQuery('')
      }
      if (effortOpen && effortRef.current && !effortRef.current.contains(target)) {
        setEffortOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [pickerOpen, effortOpen, sheetMode])

  // Focus search input on open
  useEffect(() => {
    if (pickerOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [pickerOpen])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on the directory state because
  // async catalog loads resize the card; the panel-size observer below catches
  // the resizes no state change announces, such as collapsing a group.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!pickerOpen) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the picker is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = pickerRef.current?.offsetWidth ?? 0
      const lh = pickerRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      // Replay on every observed size change; skip the state write when the
      // clamp lands on the same spot so the observer cannot loop on itself.
      setMenuPos(prev => prev !== null && prev.left === x && prev.top === y ? prev : { left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as the open), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // Collapsing or expanding a group resizes the card without a state change,
    // a scroll, or a window resize; the observer re-anchors and re-clamps it.
    // The guard keeps the picker usable where `ResizeObserver` is absent,
    // which is how jsdom runs.
    const panel = pickerRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [pickerOpen, state])
  /* jscpd:ignore-end */

  // All enabled model choices (uses 0ms cached hidden check)
  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models
      .filter(model => !isModelHidden(group.id, model.id) || (activeSel?.provider === group.id && activeSel.model === model.id))
      .map(model => ({
        group,
        model,
        selection: {
          provider: group.id,
          model: model.id,
          ...model.reasoning?.defaultEffort === undefined
            ? {}
            : { reasoningEffort: model.reasoning.defaultEffort },
        } satisfies ModelSelection,
      }))), [state.groups, prefsVersion, activeSel, isModelHidden])

  const selectedIndex = activeSel === null
    ? -1
    : choices.findIndex(c => c.selection.provider === activeSel?.provider && c.selection.model === activeSel.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = activeSel?.reasoningEffort ?? reasoning?.defaultEffort
  const defaultEffortLabel = t('effort.providerDefault')
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? defaultEffortLabel
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort

  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: defaultEffortLabel }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, defaultEffortLabel])

  if (!available) return null

  /** Raise one transient banner anchored to the composer card. */
  const raise = (text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  /**
   * Surface the submit outcome after the 0ms close. A RemoteResult carries the
   * Host's own refusal; an override's boolean leaves its message on the
   * directory snapshot. Success needs nothing — the shared current already
   * moved.
   */
  const announce = (outcome: RemoteResult<void> | boolean | undefined): void => {
    if (outcome === undefined || outcome === true) return
    if (outcome === false) {
      const message = directory.getSnapshot().error
      if (message !== null) raise(t('error.action', { message }))
      return
    }
    if (outcome.ok) return
    const { error } = outcome
    raise(error.code === 'session/writer-held'
      ? t('error.sessionInUse')
      : t('error.action', { message: `${error.code}: ${error.message}` }))
  }

  const choose = (selection: ModelSelection): void => {
    recordRecentModel(selection.provider, selection.model)
    // 0ms instant UI close: popover dismisses immediately on click without waiting for network/disk RPCs
    setPickerOpen(false)
    setSearchQuery('')
    if (activeSel?.provider === selection.provider && activeSel.model === selection.model) {
      return
    }
    lastActionRef.current = 'select'
    const submit = override !== undefined ? override.select : select
    void submit(selection).then(announce)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (activeSel === null) return
    // 0ms instant UI close for reasoning effort menu
    setEffortOpen(false)
    if (effectiveEffort === effort) {
      return
    }
    const selection: ModelSelection = {
      provider: activeSel.provider,
      model: activeSel.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
      // An effort change on a group assignment stays inside the group.
      ...activeSel.chain === undefined ? {} : { chain: activeSel.chain },
    }
    lastActionRef.current = 'select'
    const submit = override !== undefined ? override.select : select
    void submit(selection).then(announce)
  }

  // Model lookup map for quick access (computed on-demand when popover opens)
  const modelLookup = useMemo(() => {
    if (!pickerOpen) return new Map<string, { groupName: string; model: typeof state.groups[0]['models'][0]; group: typeof state.groups[0] }>()
    const map = new Map<string, { groupName: string; model: typeof state.groups[0]['models'][0]; group: typeof state.groups[0] }>()
    for (const g of state.groups) {
      for (const m of g.models) {
        map.set(`${g.id}::${m.id}`, { groupName: g.name, model: m, group: g })
      }
    }
    return map
  }, [state.groups, pickerOpen])

  // Custom ordered providers (computed on-demand when popover opens)
  const orderedGroups = useMemo(() => {
    if (!pickerOpen) return []
    const customOrder = getProviderOrder()
    const groupsCopy = [...state.groups]
    if (customOrder.length === 0) return groupsCopy
    groupsCopy.sort((a, b) => {
      const idxA = customOrder.indexOf(a.id)
      const idxB = customOrder.indexOf(b.id)
      if (idxA >= 0 && idxB >= 0) return idxA - idxB
      if (idxA >= 0) return -1
      if (idxB >= 0) return 1
      return 0
    })
    return groupsCopy
  }, [state.groups, prefsVersion, pickerOpen])

  // Favorites list (computed on-demand when popover opens) - uses cached hidden check
  const favoriteItems = useMemo(() => {
    if (!pickerOpen) return []
    const favRefs = getFavoriteModels()
    const result: Array<{ provider: string; model: typeof state.groups[0]['models'][0]; groupName: string }> = []
    for (const ref of favRefs) {
      const hit = modelLookup.get(`${ref.provider}::${ref.modelId}`)
      const isCur = activeSel?.provider === ref.provider && activeSel.model === ref.modelId
      if (hit && (!isModelHidden(ref.provider, ref.modelId) || isCur)) {
        result.push({ provider: ref.provider, model: hit.model, groupName: hit.groupName })
      }
    }
    return result
  }, [modelLookup, prefsVersion, activeSel, pickerOpen, isModelHidden])

  // Recents list (computed on-demand when popover opens) - uses cached hidden check
  const recentItems = useMemo(() => {
    if (!pickerOpen) return []
    const recents = getRecentModels()
    const result: Array<{ provider: string; model: typeof state.groups[0]['models'][0]; groupName: string }> = []
    for (const ref of recents) {
      const hit = modelLookup.get(`${ref.provider}::${ref.modelId}`)
      const isCur = activeSel?.provider === ref.provider && activeSel.model === ref.modelId
      if (hit && (!isModelHidden(ref.provider, ref.modelId) || isCur)) {
        if (!isModelFavorite(ref.provider, ref.modelId)) {
          result.push({ provider: ref.provider, model: hit.model, groupName: hit.groupName })
        }
      }
    }
    return result
  }, [modelLookup, prefsVersion, activeSel, pickerOpen, isModelHidden])

  // Filtered queries
  const q = searchQuery.toLowerCase().trim()

  // Rule-hidden catalogue entries an active search reveals with their reason
  // (manual hidden pins never resurface); the group render reads this set.
  const revealedHidden = useMemo(() => {
    const keys = new Set<string>()
    if (q === '') return keys
    for (const group of state.groups) {
      for (const model of group.models) {
        if (!(model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q))) continue
        if (activeSel?.provider === group.id && activeSel.model === model.id) continue
        if (isHiddenCached(group.id, model.id)) continue
        // A shown pin renders as an ordinary row (the engine's map may not
        // have caught up yet): never also list it as a dimmed hidden match.
        if (isShownCached(group.id, model.id)) continue
        const decision = decisionFor(group.id, model.id)
        if (decision?.state === 'hidden' && decision.source !== 'manual') keys.add(`${group.id}/${model.id}`)
      }
    }
    return keys
  }, [state.groups, q, activeSel, isHiddenCached, isShownCached, decisionFor])

  // Assignable model groups: enabled groups with at least one link, read from
  // the cached registry and refreshed on the groups-changed event.
  const chainGroups = useMemo(() => assignableModelGroups(), [prefsVersion])

  const filteredFavorites = useMemo(() => {
    if (!q) return favoriteItems
    return favoriteItems.filter(f => f.model.name.toLowerCase().includes(q) || f.model.id.toLowerCase().includes(q))
  }, [favoriteItems, q])

  // Groups answer the same search box as models: label, id, or an ordered link.
  const filteredChainGroups = useMemo(() => {
    if (!q) return chainGroups
    return chainGroups.filter(group =>
      group.label.toLowerCase().includes(q)
      || group.id.toLowerCase().includes(q)
      || group.links.some(link => `${link.provider}/${link.model}`.toLowerCase().includes(q)))
  }, [chainGroups, q])

  // Reorder Provider Groups via Drag & Drop
  const handleProviderDragStart = (e: DragEvent, providerId: string) => {
    e.dataTransfer.setData('text/plain', providerId)
    setDraggedProvider(providerId)
  }

  const handleProviderDragOver = (e: DragEvent, targetProviderId: string) => {
    e.preventDefault()
    setDragOverItem(targetProviderId)
  }

  const handleProviderDrop = (e: DragEvent, targetProviderId: string) => {
    e.preventDefault()
    setDragOverItem(null)
    if (!draggedProvider || draggedProvider === targetProviderId) return
    const currentOrder = orderedGroups.map(g => g.id)
    const fromIdx = currentOrder.indexOf(draggedProvider)
    const toIdx = currentOrder.indexOf(targetProviderId)
    if (fromIdx >= 0 && toIdx >= 0) {
      currentOrder.splice(fromIdx, 1)
      currentOrder.splice(toIdx, 0, draggedProvider)
      setProviderOrder(currentOrder)
      setPrefsVersion(v => v + 1)
    }
    setDraggedProvider(null)
  }

  // Reorder Favorites via Drag & Drop
  const handleFavoriteDragStart = (e: DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', String(index))
    setDraggedFavorite(index)
  }

  const handleFavoriteDrop = (e: DragEvent, targetIndex: number) => {
    e.preventDefault()
    setDragOverItem(null)
    if (draggedFavorite === null || draggedFavorite === targetIndex) return
    const favs = getFavoriteModels()
    const moved = favs[draggedFavorite]
    if (moved) {
      favs.splice(draggedFavorite, 1)
      favs.splice(targetIndex, 0, moved)
      setFavoriteModels(favs)
      setPrefsVersion(v => v + 1)
    }
    setDraggedFavorite(null)
  }

  // Enpoi Harness fallback: an old session may name a model no longer in the
  // catalog (renamed/removed route) — show its raw id instead of a blank
  // trigger so the picker never looks broken on legacy sessions. When an
  // override names a placeholder (e.g. "Inherit"), unassigned rows use that.
  const fallbackLabel = override?.placeholder ?? t('trigger.fallback')
  // A group assignment labels the trigger with the group, not the active link.
  const activeChain = activeSel?.chain === undefined ? undefined : modelGroupById(activeSel.chain)
  const modelLabel = activeChain?.label ?? currentChoice?.model.name ?? activeSel?.model ?? fallbackLabel

  // Picker body shared by the desktop popover and the phone sheet.
  const pickerPanel = (
    <>
      {/* Search Header */}
      <div className={css.searchHeader}>
        <span className={css.searchIcon}>
          <IconSearch />
        </span>
        <input
          ref={searchInputRef}
          className={css.searchInput}
          type="text"
          placeholder={t('search.placeholder')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className={css.clearSearchBtn}
            onClick={() => setSearchQuery('')}
          >
            ×
          </button>
        )}
      </div>

      <div className={clsx(css.pickerScrollable, 'scrollable')}>
        {/* MODEL GROUPS (above Favorites; rendered only when groups exist) */}
        {filteredChainGroups.length > 0 && (
          <div className={css.groupSection}>
            <div
              className={css.groupHeader}
              onClick={() => {
                toggleGroupCollapsed('__chains__')
                setPrefsVersion(v => v + 1)
              }}
            >
              <div className={css.groupHeaderLeft}>
                <span className={css.groupIcon}>
                  <IconChain />
                </span>
                <span className={css.groupTitleText}>{t('group.groups')}</span>
                <span className={css.groupBadge}>{filteredChainGroups.length}</span>
              </div>
              <span className={clsx(css.groupChevron, !collapsedSet.has('__chains__') && css.groupChevronExpanded)}>
                <IconChevron />
              </span>
            </div>

            {!collapsedSet.has('__chains__') && (
              <div className={css.groupBody}>
                {filteredChainGroups.map((group) => {
                  const first = group.links[0]
                  if (first === undefined) return null
                  const isSelected = activeSel?.chain === group.id
                  return (
                    <div
                      key={`chain-${group.id}`}
                      className={clsx(css.modelRow, isSelected && css.modelRowSelected)}
                      data-model-row=""
                      title={group.links.map(link => `${link.provider}/${link.model}`).join('\n')}
                      onClick={() => {
                        choose({
                          provider: first.provider,
                          model: first.model,
                          // The head link's declared effort is what the runtime
                          // applies to this route; logging it keeps the recorded
                          // request header in step with the dispatched request.
                          ...first.effort === undefined ? {} : { reasoningEffort: first.effort },
                          chain: group.id,
                        })
                      }}
                    >
                      <div className={css.modelRowLeft}>
                        <span className={css.chainRowIcon}>
                          <IconChain />
                        </span>
                        <span className={css.modelNameText}>{group.label}</span>
                      </div>
                      <div className={css.modelRowRight}>
                        <span className={css.contextTag}>
                          {group.links.length === 1
                            ? t('group.model', { count: group.links.length })
                            : t('group.models', { count: group.links.length })}
                        </span>
                        {isSelected && <IconCheck className={css.checkIcon} />}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* FAVORITES GROUP */}
        {filteredFavorites.length > 0 && (
          <div className={css.groupSection}>
            <div
              className={css.groupHeader}
              onClick={() => {
                toggleGroupCollapsed('__favorites__')
                setPrefsVersion(v => v + 1)
              }}
            >
              <div className={css.groupHeaderLeft}>
                <span className={css.groupIcon} style={{ color: '#fbbf24' }}>
                  <IconStar filled />
                </span>
                <span className={css.groupTitleText}>{t('group.favorites')}</span>
                <span className={css.groupBadge}>{filteredFavorites.length}</span>
              </div>
              <span className={clsx(css.groupChevron, !collapsedSet.has('__favorites__') && css.groupChevronExpanded)}>
                <IconChevron />
              </span>
            </div>

            {!collapsedSet.has('__favorites__') && (
              <div className={css.groupBody}>
                {filteredFavorites.map((fav, fIdx) => {
                  const isSelected = activeSel?.provider === fav.provider && activeSel.model === fav.model.id
                  const contextStr = resolveModelContext(fav.model)

                  return (
                    <div
                      key={`fav-${fav.provider}-${fav.model.id}`}
                      className={clsx(css.modelRow, isSelected && css.modelRowSelected)}
                      data-model-row=""
                      draggable={!q}
                      onDragStart={e => handleFavoriteDragStart(e, fIdx)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => handleFavoriteDrop(e, fIdx)}
                      onClick={() => choose({ provider: fav.provider, model: fav.model.id })}
                    >
                      <div className={css.modelRowLeft}>
                        {!q && (
                          <span className={css.dragHandle} title={t('favorite.dragReorder')}>
                            <IconGrip />
                          </span>
                        )}
                        <span className={css.modelNameText}>{fav.model.name}</span>
                      </div>
                      <div className={css.modelRowRight}>
                        {contextStr && <span className={css.contextTag}>{contextStr}</span>}
                        <button
                          type="button"
                          className={clsx(css.starBtn, css.starBtnActive)}
                          title={t('favorite.remove')}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleModelFavorite(fav.provider, fav.model.id)
                            setPrefsVersion(v => v + 1)
                          }}
                        >
                          <IconStar filled />
                        </button>
                        {isSelected && <IconCheck className={css.checkIcon} />}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* RECENTS GROUP (when not searching) */}
        {!q && recentItems.length > 0 && (
          <div className={css.groupSection}>
            <div
              className={css.groupHeader}
              onClick={() => {
                toggleGroupCollapsed('__recents__')
                setPrefsVersion(v => v + 1)
              }}
            >
              <div className={css.groupHeaderLeft}>
                <span className={css.groupIcon}>
                  <IconClock />
                </span>
                <span className={css.groupTitleText}>{t('group.recent')}</span>
                <span className={css.groupBadge}>{recentItems.length}</span>
              </div>
              <span className={clsx(css.groupChevron, !collapsedSet.has('__recents__') && css.groupChevronExpanded)}>
                <IconChevron />
              </span>
            </div>

            {!collapsedSet.has('__recents__') && (
              <div className={css.groupBody}>
                {recentItems.map((rec) => {
                  const isSelected = activeSel?.provider === rec.provider && activeSel.model === rec.model.id
                  const isFav = isModelFavorite(rec.provider, rec.model.id)
                  const contextStr = resolveModelContext(rec.model)

                  return (
                    <div
                      key={`rec-${rec.provider}-${rec.model.id}`}
                      className={clsx(css.modelRow, isSelected && css.modelRowSelected)}
                      data-model-row=""
                      onClick={() => choose({ provider: rec.provider, model: rec.model.id })}
                    >
                      <div className={css.modelRowLeft}>
                        <span className={css.modelNameText}>{rec.model.name}</span>
                      </div>
                      <div className={css.modelRowRight}>
                        {contextStr && <span className={css.contextTag}>{contextStr}</span>}
                        <button
                          type="button"
                          className={clsx(css.starBtn, isFav && css.starBtnActive)}
                          title={isFav ? t('favorite.remove') : t('favorite.add')}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleModelFavorite(rec.provider, rec.model.id)
                            setPrefsVersion(v => v + 1)
                          }}
                        >
                          <IconStar filled={isFav} />
                        </button>
                        {isSelected && <IconCheck className={css.checkIcon} />}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* PROVIDER GROUPS - uses 0ms cached hidden/collapsed checks */}
        {orderedGroups.map((group) => {
          const visibleModels = group.models.filter((m) => {
            const matchesSearch = !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
            if (!matchesSearch) return false
            const isCurrent = activeSel?.provider === group.id && activeSel.model === m.id
            return isCurrent || !isModelHidden(group.id, m.id)
          })
          const hiddenMatches = q === ''
            ? []
            : group.models.filter(model => revealedHidden.has(`${group.id}/${model.id}`))

          if (visibleModels.length === 0 && hiddenMatches.length === 0) return null

          const isCollapsed = !q && collapsedSet.has(group.id)

          return (
            <div
              key={group.id}
              className={clsx(css.groupSection, dragOverItem === group.id && css.dragOver)}
              onDragOver={e => handleProviderDragOver(e, group.id)}
              onDrop={e => handleProviderDrop(e, group.id)}
            >
              <div
                className={css.groupHeader}
                onClick={() => {
                  if (!q) {
                    toggleGroupCollapsed(group.id)
                    setPrefsVersion(v => v + 1)
                  }
                }}
              >
                <div className={css.groupHeaderLeft}>
                  {!q && (
                    <span
                      className={css.dragHandle}
                      draggable
                      onDragStart={e => handleProviderDragStart(e, group.id)}
                      onClick={e => e.stopPropagation()}
                      title={t('provider.dragReorder')}
                    >
                      <IconGrip />
                    </span>
                  )}
                  <span className={css.groupTitleText}>{group.name}</span>
                  <span className={css.groupBadge}>{visibleModels.length}</span>
                </div>
                <span className={clsx(css.groupChevron, !isCollapsed && css.groupChevronExpanded)}>
                  <IconChevron />
                </span>
              </div>

              {!isCollapsed && (
                <div className={css.groupBody}>
                  {visibleModels.map((model) => {
                    const isSelected = activeSel?.provider === group.id && activeSel.model === model.id
                    const isFav = isModelFavorite(group.id, model.id)
                    const contextStr = resolveModelContext(model)
                    // A manual shown pin that had to override something carries
                    // the engine's reason; a plain pin stays unbadged.
                    const decision = decisionFor(group.id, model.id)
                    const pinnedReason = decision?.state === 'visible' && decision.source === 'manual' && decision.reason !== 'pinned visible'
                      ? decision.reason
                      : undefined

                    return (
                      <div
                        key={model.id}
                        className={clsx(css.modelRow, isSelected && css.modelRowSelected)}
                        data-model-row=""
                        onClick={() => choose({ provider: group.id, model: model.id })}
                      >
                        <div className={css.modelRowLeft}>
                          <span className={css.modelNameText}>{model.name}</span>
                        </div>
                        <div className={css.modelRowRight}>
                          {contextStr && <span className={css.contextTag}>{contextStr}</span>}
                          {pinnedReason !== undefined && pinnedReason !== null && (
                            <span className={css.ruleTag}>{pinnedReason}</span>
                          )}
                          <button
                            type="button"
                            className={clsx(css.starBtn, isFav && css.starBtnActive)}
                            title={isFav ? t('favorite.remove') : t('favorite.add')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelFavorite(group.id, model.id)
                              setPrefsVersion(v => v + 1)
                            }}
                          >
                            <IconStar filled={isFav} />
                          </button>
                          {isSelected && <IconCheck className={css.checkIcon} />}
                        </div>
                      </div>
                    )
                  })}
                  {/* Hidden-by-rule matches surface on an explicit search, dimmed
                      and selectable only through a manual shown pin — the reason
                      stays visible instead of a silent disappearance. */}
                  {hiddenMatches.map((model) => {
                    const reason = decisionFor(group.id, model.id)?.reason
                    const contextStr = resolveModelContext(model)
                    return (
                      <div
                        key={`rule-hidden-${model.id}`}
                        className={clsx(css.modelRow, css.modelRowHidden)}
                        data-model-hidden=""
                        title={reason ?? undefined}
                        aria-disabled
                      >
                        <div className={css.modelRowLeft}>
                          <span className={css.modelNameText}>{model.name}</span>
                        </div>
                        <div className={css.modelRowRight}>
                          {contextStr && <span className={css.contextTag}>{contextStr}</span>}
                          {reason !== null && reason !== undefined && <span className={css.ruleTag}>{reason}</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Empty search results */}
        {q && revealedHidden.size === 0 &&
          choices.filter(c => c.model.name.toLowerCase().includes(q) || c.model.id.toLowerCase().includes(q)).length === 0 && (
          <div className={css.emptyState}>{t('empty.search', { query: searchQuery })}</div>
        )}
      </div>
    </>
  )

  const effortPanel = (
    <>
      {effortChoices.map((level) => {
        const isSelected = effectiveEffort === level.effort
        return (
          <button
            key={level.key}
            type="button"
            className={clsx(css.effortItem, isSelected && css.effortItemSelected)}
            onClick={() => chooseEffort(level.effort)}
          >
            <span>{level.label}</span>
            {isSelected && <IconCheck className={css.checkIcon} />}
          </button>
        )
      })}
    </>
  )

  return (
    <div ref={rootRef} className={clsx(css.root, compact === true && css.compactRoot)}>
      {/* 1. Main Model Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.modelTrigger, pickerOpen && css.modelTriggerActive)}
        title={modelLabel}
        data-model-trigger
        disabled={locked}
        onClick={() => {
          setEffortOpen(false)
          setPickerOpen(!pickerOpen)
        }}
      >
        {activeChain !== undefined && (
          <span className={css.chainTriggerIcon} aria-hidden>
            <IconChain />
          </span>
        )}
        <span className={css.modelNameLabel}>{modelLabel}</span>
        <span className={clsx(css.chevronIcon, pickerOpen && css.chevronOpen)}>
          <IconChevron />
        </span>
      </button>

      {/* 2. Conditional Reasoning Effort Pill (Only rendered if model supports reasoning!) */}
      {reasoning !== undefined && effortChoices.length > 0 && (
        <button
          type="button"
          className={clsx(css.effortTrigger, effortOpen && css.effortTriggerActive)}
          title={t('effort.triggerTitle', { effort: effortLabel })}
          data-effort-trigger
          disabled={locked}
          onClick={() => {
            setPickerOpen(false)
            setEffortOpen(!effortOpen)
          }}
        >
          <span className={css.triggerIcon}>
            <IconBrain />
          </span>
          <span className={css.effortText}>{effortLabel}</span>
          <span className={clsx(css.chevronIcon, effortOpen && css.chevronOpen)}>
            <IconChevron />
          </span>
        </button>
      )}

      {/* 3. Main Model Picker: the anchored popover on desktop, a bottom
          sheet at phone widths (search, favourites, recents, hidden-model
          honouring, and the current row all preserved inside the sheet). */}
      {pickerOpen && (sheetMode
        ? (
          <Sheet
            open
            onClose={() => { setPickerOpen(false); setSearchQuery('') }}
            title={t('menu.aria')}
            closeLabel={t('menu.close')}
            surfaceId="ui-model-selection:picker"
            contentClassName={css.sheetContent ?? ''}
          >
            {pickerPanel}
          </Sheet>
        )
        : createPortal(
          <div
            ref={pickerRef}
            className={css.pickerPopover}
            data-model-popover
            style={menuPos ?? MEASURE_STYLE}
            role="menu"
            aria-label={t('menu.aria')}
            aria-busy={state.status === 'loading' || state.status === 'selecting'}
          >
            {pickerPanel}
          </div>,
          document.body,
        ))}

      {/* 4. Compact Effort Level Popover: anchored on desktop, a sheet at
          phone widths. */}
      {effortOpen && reasoning !== undefined && (sheetMode
        ? (
          <Sheet
            open
            onClose={() => { setEffortOpen(false) }}
            title={t('menu.effort')}
            closeLabel={t('menu.close')}
            surfaceId="ui-model-selection:effort"
            contentClassName={css.sheetContent ?? ''}
          >
            {effortPanel}
          </Sheet>
        )
        : (
          <div ref={effortRef} className={css.effortPopover}>
            {effortPanel}
          </div>
        ))}

      {/* Toast Feedback */}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  )
}
