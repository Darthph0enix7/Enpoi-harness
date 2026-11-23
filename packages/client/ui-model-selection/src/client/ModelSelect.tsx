/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * OpenChamber-style Model Picker & Input Card design:
 * - Trigger Bar: Clean Model Button (opens picker popover directly) + Conditional Reasoning Effort Pill.
 * - Model Picker Popover (MenuSurface material and elevation tokens):
 *   - Search Bar for instant filtering across all providers.
 *   - Collapsible Favorites, Recents, Groups, and Provider sections. Every
 *     header is a native toggle with `aria-expanded`.
 *   - Search semantics: matching sections expand by default; zero-match
 *     sections leave the list; a user's search-time toggle wins for the rest
 *     of that query; clearing restores the saved pre-search state.
 *   - Clean model rows: human-readable name, compact context size, Star toggle.
 *   - A provider tag appears only when a display name or model id collides
 *     across providers; accessible names and titles always name the provider.
 *   - Rule-aware visibility: entries the host rules engine hides carry their
 *     reason when the search asks for them; a manual shown pin that overrode a
 *     hide rule shows the rule it beat.
 *   - Keyboard: arrows walk visible rows (collapsed sections render none),
 *     Home/End jump, type-ahead matches name prefixes or word segments, and
 *     Escape closes back to the trigger.
 *
 * Data and submission ride the SAME per-session ModelDirectory as the /model
 * popup, and a pick reflects immediately (0ms) while the Host answer settles.
 * A rejected selection announces through the shared transient Toast anchored
 * to the composer card.
 *
 * @module dsh-client-ui-model-selection/ModelSelect
 */

import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { MenuSurface, Sheet, Toast, useSheetPresentation } from '@deepseek-ai/dsh-client-ui-primitives'
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
  MODEL_GROUPS_CHANGED_EVENT, ensureModelGroups, modelGroupById, pickerModelGroups, refreshModelGroups,
} from './model-groups.ts'
import {
  CATALOG_VISIBILITY_CHANGED_EVENT, catalogVisibilitySnapshot, ensureCatalogVisibility,
} from './catalog-visibility.ts'
import { resolveSectionCollapsed, toggleSearchCollapse, type SearchCollapseToggles } from './picker-collapse.ts'
import { ambiguousModelKeys, modelRowKey } from './picker-duplicates.ts'
import {
  pickerNavTargets, movePickerFocus, nextTypeAheadTarget, typeAheadQuery,
  type PickerNavMove,
} from './picker-navigation.ts'
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

/**
 * Format the disclosed model context window, marking a route-default fallback
 * as assumed rather than printing it as a disclosed capacity.
 * @param model - catalog row whose context capacity is displayed.
 * @param t - the package dictionary translate.
 * @returns the compact capacity tag, or an empty string when none is disclosed.
 */
function resolveModelContext(model: ModelContextTarget, t: PropsLocale<'model'>['t']): string {
  const tokens = resolveContextTokens(model)
  if (tokens <= 0) return ''
  const size = formatCompactContext(tokens)
  const hasDisclosedContext = model.contextWindowSource !== 'default'
    && ((typeof model.contextWindow === 'number' && model.contextWindow > 0)
      || (typeof model.context?.contextWindow === 'number' && model.context.contextWindow > 0))
  const hasDisclosedInput = model.maxInputTokensSource !== 'default'
    && ((typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0)
      || (typeof model.context?.maxInputTokens === 'number' && model.context.maxInputTokens > 0))
  const isAssumed = !hasDisclosedContext && !hasDisclosedInput
    && (model.contextWindowSource === 'default' || model.maxInputTokensSource === 'default')
  return isAssumed ? t('context.assumed', { tokens: size }) : size
}

/**
 * Catalog-derived row markers. The picker makes no supported-modality claim,
 * and an unverified row says so.
 * @param model - catalog row whose provenance markers are rendered.
 * @param t - the package dictionary translate.
 * @returns the row's context and provenance tags.
 */
function ModelCapabilityTags(
  { model, t }: { model: ModelContextTarget; t: PropsLocale<'model'>['t'] },
): React.ReactNode {
  const context = resolveModelContext(model, t)
  return (
    <>
      {context !== '' && <span className={css.contextTag}>{context}</span>}
      {model.unverified === true && <span className={css.ruleTag}>{t('capability.unverified')}</span>}
    </>
  )
}

/** One collapsible section header: a native toggle with its badge and chevron. */
function PickerGroupHeader(
  { id, bodyId, title, count, expanded, icon, dragHandle, onToggle, className }: {
    /** Stable id of the toggle, used as the body's accessible name. */
    id: string
    /** Stable id of the body the toggle controls while expanded. */
    bodyId: string
    /** Visible section name. */
    title: string
    /** Number of rows the section currently shows. */
    count: number
    /** Whether the body is rendered. */
    expanded: boolean
    /** Optional leading glyph. */
    icon?: ReactNode
    /** Optional provider drag handle rendered before the toggle. */
    dragHandle?: ReactNode
    /** Section toggle handler. */
    onToggle: () => void
    /** Extra section state classes. */
    className?: string
  },
): React.ReactElement {
  return (
    <div className={clsx(css.groupHeader, className)}>
      {dragHandle}
      <button
        type="button"
        id={id}
        className={css.groupHeaderToggle}
        aria-expanded={expanded}
        {...expanded ? { 'aria-controls': bodyId } : {}}
        onClick={onToggle}
      >
        {icon}
        <span className={css.groupTitleText}>{title}</span>
        <span className={css.groupBadge} aria-hidden>{count}</span>
        <span className={clsx(css.groupChevron, expanded && css.groupChevronExpanded)} aria-hidden>
          <IconChevron />
        </span>
      </button>
    </div>
  )
}

/** One selectable model row; the star stays a sibling so buttons never nest. */
function PickerRow(
  {
    provider, name, providerTagged, selected, mode, tags, leading, trailing, onSelect,
    title, draggable, onDragStart, onDragOver, onDrop,
  }: {
    /** Provider (or section) the row belongs to. */
    provider: string
    /** Model display name. */
    name: string
    /** Whether the visible provider tag is needed because another provider reuses the name or id. */
    providerTagged: boolean
    /** Whether this row is the active selection. */
    selected: boolean
    /** Selectable rows become buttons; hidden and disabled rows stay inert. */
    mode: 'selectable' | 'disabled' | 'hidden'
    /** Capability and rule tags shown before the check mark. */
    tags?: ReactNode
    /** Leading drag handle or section glyph. */
    leading?: ReactNode
    /** Trailing star control. */
    trailing?: ReactNode
    /** Selection handler for selectable rows. */
    onSelect?: () => void
    /** Extra reason appended to the accessible description. */
    title?: string | undefined
    /** Whether the row can be dragged (favorites and provider order). */
    draggable?: boolean
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void
    onDragOver?: (event: DragEvent<HTMLDivElement>) => void
    onDrop?: (event: DragEvent<HTMLDivElement>) => void
  },
): React.ReactElement {
  const accessible = `${name}, ${provider}`
  const description = title === undefined ? accessible : `${accessible}: ${title}`
  const body = (
    <>
      {leading}
      <span className={css.modelRowLeft}>
        <span className={css.modelNameText}>{name}</span>
      </span>
      <span className={css.modelRowRight}>
        {providerTagged && <span className={css.providerTag}>{provider}</span>}
        {tags}
        {selected && <IconCheck className={css.checkIcon} aria-hidden />}
      </span>
    </>
  )
  if (mode !== 'selectable') {
    return (
      <div
        className={clsx(css.modelRow, mode === 'hidden' ? css.modelRowHidden : css.modelRowDisabled)}
        data-model-row=""
        {...mode === 'hidden' ? { 'data-model-hidden': '' } : { 'data-model-disabled': '' }}
        aria-disabled
        title={description}
      >
        {body}
      </div>
    )
  }
  return (
    <div
      className={clsx(css.modelRow, selected && css.modelRowSelected)}
      data-model-row=""
      {...selected ? { 'data-model-selected': '' } : {}}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className={css.modelRowMain}
        data-model-nav=""
        data-model-name={name.toLowerCase()}
        aria-label={accessible}
        title={description}
        onClick={onSelect}
      >
        {leading}
        <span className={css.modelRowLeft}>
          <span className={css.modelNameText}>{name}</span>
        </span>
        <span className={css.modelRowRight}>
          {providerTagged && <span className={css.providerTag}>{provider}</span>}
          {tags}
          {selected && <IconCheck className={css.checkIcon} aria-hidden />}
        </span>
      </button>
      {trailing}
    </div>
  )
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
  const [searchToggles, setSearchToggles] = useState<SearchCollapseToggles>(() => new Map())
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
  const listRef = useRef<HTMLDivElement | null>(null)
  const typeAheadRef = useRef({ buffer: '', at: 0 })
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const pickerId = useId()
  const bodyId = (kind: string, index: number): string => `${pickerId}-${kind}-${String(index)}`

  // Listen to preference changes across tabs / components
  useEffect(() => {
    const onPrefsChange = () => { setPrefsVersion(v => v + 1) }
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

  const q = searchQuery.toLowerCase().trim()
  const searching = q !== ''
  // Search-time toggles live only for the active query. Clearing the query
  // drops them, so the next search starts from the saved preference again and
  // the pre-search view is restored exactly.
  useEffect(() => {
    if (!searching) setSearchToggles(previous => previous.size === 0 ? previous : new Map())
  }, [searching])
  const isSectionCollapsed = (section: string): boolean =>
    resolveSectionCollapsed(section, searching, collapsedSet, searchToggles)
  const toggleSection = (section: string): void => {
    if (searching) {
      setSearchToggles(previous => toggleSearchCollapse(previous, section))
      return
    }
    toggleGroupCollapsed(section)
    setPrefsVersion(version => version + 1)
  }
  // Provider label for tags and the trigger suffix. The account group is the
  // one provider whose catalogue name is localized.
  const providerNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const group of state.groups) {
      names.set(group.id, group.id === 'deepseek-account' ? t('provider.account') : group.name)
    }
    return names
  }, [state.groups, t])
  const providerName = (provider: string, fallback?: string): string =>
    providerNames.get(provider) ?? fallback ?? provider
  // Collisions cover the full catalogue, never the filtered list: the row tag
  // and the trigger suffix stay fixed while the user types.
  const ambiguousKeys = useMemo(() => ambiguousModelKeys(state.groups), [state.groups])

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
    return () => { document.removeEventListener('mousedown', onDocClick) }
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
    : choices.findIndex(c => c.selection.provider === activeSel.provider && c.selection.model === activeSel.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = activeSel?.reasoningEffort ?? reasoning?.defaultEffort
  // A saved effort the selected model does not offer is stale: an older
  // catalog entry, or a resume onto a provider that discloses no ladder. It
  // stays visible so the user can clear it with the provider-default action
  // instead of being trapped by a request the Host refuses. An unavailable
  // model has no effort control: choosing any routable model replaces the
  // whole selection, including the stale effort.
  const staleEffort = currentChoice !== undefined && activeSel?.reasoningEffort !== undefined
    && (reasoning === undefined || !reasoning.efforts.some(level => level.id === activeSel.reasoningEffort))
    ? activeSel.reasoningEffort
    : undefined
  const defaultEffortLabel = t('effort.providerDefault')
  const effortLabel = reasoning === undefined
    ? staleEffort
    : effectiveEffort === undefined
      ? defaultEffortLabel
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort

  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? staleEffort === undefined
      ? []
      : [{ key: 'provider-default', effort: undefined, label: defaultEffortLabel }]
    : [
      ...reasoning.defaultEffort === undefined || staleEffort !== undefined
        ? [{ key: 'provider-default', effort: undefined, label: defaultEffortLabel }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, defaultEffortLabel, staleEffort])

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
    triggerRef.current?.focus()
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

  // Model groups render from the host's resolved projection: a selector-only
  // group shows its resolved member count, and a retired group stays visible
  // (marked disabled) instead of disappearing.
  const chainGroups = useMemo(() => pickerModelGroups(), [prefsVersion])

  const filteredFavorites = useMemo(() => {
    if (!q) return favoriteItems
    return favoriteItems.filter(f => f.model.name.toLowerCase().includes(q) || f.model.id.toLowerCase().includes(q))
  }, [favoriteItems, q])

  // Groups answer the same search box as models: label, id, or a resolved member.
  const filteredChainGroups = useMemo(() => {
    if (!q) return chainGroups
    return chainGroups.filter(group =>
      group.label.toLowerCase().includes(q)
      || group.id.toLowerCase().includes(q)
      || group.members.some(link => `${link.provider}/${link.model}`.toLowerCase().includes(q)))
  }, [chainGroups, q])

  // Provider sections see one filter for both rendering and the empty state:
  // a section with no visible row never renders its header.
  const providerSections = useMemo(() => {
    return orderedGroups.flatMap((group) => {
      const visibleModels = group.models.filter((model) => {
        const matchesSearch = !q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
        if (!matchesSearch) return false
        const isCurrent = activeSel?.provider === group.id && activeSel.model === model.id
        return isCurrent || !isModelHidden(group.id, model.id)
      })
      const hiddenMatches = q === ''
        ? []
        : group.models.filter(model => revealedHidden.has(`${group.id}/${model.id}`))
      return visibleModels.length === 0 && hiddenMatches.length === 0
        ? []
        : [{ group, visibleModels, hiddenMatches }]
    })
  }, [orderedGroups, q, activeSel, isModelHidden, revealedHidden])

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
  // catalog (renamed/removed route) — show its raw provider/model id instead of
  // a blank trigger so the picker never looks broken on legacy sessions. When
  // an override names a placeholder (e.g. "Inherit"), unassigned rows use that.
  const fallbackLabel = override?.placeholder ?? t('trigger.fallback')
  // A group assignment labels the trigger with the group, not the active link.
  const activeChain = activeSel?.chain === undefined ? undefined : modelGroupById(activeSel.chain)
  const currentProviderName = activeSel === null ? undefined : providerName(activeSel.provider)
  const currentAmbiguous = activeSel !== null && ambiguousKeys.has(modelRowKey(activeSel.provider, activeSel.model))
  const currentModelName = currentChoice?.model.name ?? activeSel?.model ?? fallbackLabel
  const staleSelection = activeSel !== null && activeChain === undefined && currentChoice === undefined
  // A stale selection is not in the catalogue, so identity falls back to the
  // saved provider/model pair; the picker never shows a bare model id.
  const modelLabel = activeChain?.label ?? (activeSel !== null && staleSelection
    ? `${currentProviderName ?? activeSel.provider}/${activeSel.model}`
    : currentModelName)
  // Ambiguity is a full-catalogue fact: the suffix stays put while the user
  // types, and appears in the trigger only when the same name or id is offered
  // by another provider.
  const triggerProvider = activeChain === undefined && currentAmbiguous ? currentProviderName : undefined
  const triggerTitle = activeChain === undefined && activeSel !== null
    ? `${currentProviderName ?? activeSel.provider} · ${currentModelName}`
    : modelLabel

  /** Close the picker, drop the query, and optionally return focus to the trigger. */
  const closePicker = (focusTrigger: boolean): void => {
    setPickerOpen(false)
    setSearchQuery('')
    if (focusTrigger) triggerRef.current?.focus()
  }

  /**
   * Keyboard walk over visible rows only: collapsed groups render no rows, and
   * rule-hidden rows carry no navigation marker. Type-ahead searches the same
   * visible set by model name.
   */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePicker(true)
      return
    }
    const move: PickerNavMove | undefined = event.key === 'ArrowDown'
      ? 'next'
      : event.key === 'ArrowUp'
        ? 'previous'
        : event.key === 'Home'
          ? 'first'
          : event.key === 'End'
            ? 'last'
            : undefined
    if (move !== undefined) {
      event.preventDefault()
      movePickerFocus(listRef.current, move)
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key.length !== 1 || event.key === ' ') return
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    typeAheadRef.current = typeAheadQuery(typeAheadRef.current, event.key, Date.now())
    const target = nextTypeAheadTarget(pickerNavTargets(listRef.current), typeAheadRef.current.buffer, focused)
    if (target !== null) target.focus()
  }

  // Picker body shared by the desktop popover and the phone sheet.
  const pickerPanel = (
    <>
      {/* Search Header */}
      <div className={css.searchHeader}>
        <span className={css.searchIcon} aria-hidden>
          <IconSearch />
        </span>
        <input
          ref={searchInputRef}
          className={css.searchInput}
          type="text"
          aria-label={t('search.aria')}
          placeholder={t('search.placeholder')}
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closePicker(true)
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              movePickerFocus(listRef.current, event.key === 'ArrowDown' ? 'first' : 'last')
            }
          }}
        />
        {searchQuery && (
          <button
            type="button"
            className={css.clearSearchBtn}
            aria-label={t('search.clear')}
            title={t('search.clear')}
            onClick={() => { setSearchQuery('') }}
          >
            ×
          </button>
        )}
      </div>

      <div
        ref={listRef}
        className={clsx(css.pickerScrollable, 'scrollable')}
        onKeyDown={onListKeyDown}
      >
        {/* MODEL GROUPS (above Favorites; rendered only when groups exist) */}
        {filteredChainGroups.length > 0 && (() => {
          const body = bodyId('chains', 0)
          const expanded = !isSectionCollapsed('__chains__')
          return (
            <div className={css.groupSection}>
              <PickerGroupHeader
                id={`${body}-header`}
                bodyId={body}
                title={t('group.groups')}
                count={filteredChainGroups.length}
                expanded={expanded}
                icon={(
                  <span className={css.groupIcon} aria-hidden>
                    <IconChain />
                  </span>
                )}
                onToggle={() => { toggleSection('__chains__') }}
              />

              {expanded && (
                <div className={css.groupBody} id={body} role="group" aria-labelledby={`${body}-header`}>
                  {filteredChainGroups.map((group) => {
                    // The head resolved member is what the runtime dispatches
                    // first; a selector-only group carries its members here, so
                    // no explicit link is needed to assign it.
                    const first = group.members[0]
                    const isSelected = activeSel?.chain === group.id
                    const tags = (
                      <>
                        <span className={css.contextTag}>
                          {group.disabled
                            ? t('group.disabled')
                            : first === undefined
                              ? t('group.noMembers')
                              : group.members.length === 1
                                ? t('group.model', { count: group.members.length })
                                : t('group.models', { count: group.members.length })}
                        </span>
                        {!group.disabled && group.selectors.length > 0 && (
                          <span className={css.dynamicTag}>{t('group.dynamic')}</span>
                        )}
                      </>
                    )
                    if (group.disabled || first === undefined) {
                      return (
                        <PickerRow
                          key={`chain-${group.id}`}
                          provider={t('group.groups')}
                          name={group.label}
                          providerTagged={false}
                          selected={isSelected}
                          mode="disabled"
                          tags={tags}
                          leading={(
                            <span className={css.chainRowIcon} aria-hidden>
                              <IconChain />
                            </span>
                          )}
                          title={group.warnings.join('\n')}
                        />
                      )
                    }
                    return (
                      <PickerRow
                        key={`chain-${group.id}`}
                        provider={t('group.groups')}
                        name={group.label}
                        providerTagged={false}
                        selected={isSelected}
                        mode="selectable"
                        tags={tags}
                        leading={(
                          <span className={css.chainRowIcon} aria-hidden>
                            <IconChain />
                          </span>
                        )}
                        title={group.members.map(link => `${link.provider}/${link.model}`).join('\n')}
                        onSelect={() => {
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
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {/* FAVORITES GROUP */}
        {filteredFavorites.length > 0 && (() => {
          const body = bodyId('favorites', 0)
          const expanded = !isSectionCollapsed('__favorites__')
          return (
            <div className={css.groupSection}>
              <PickerGroupHeader
                id={`${body}-header`}
                bodyId={body}
                title={t('group.favorites')}
                count={filteredFavorites.length}
                expanded={expanded}
                icon={(
                  <span className={clsx(css.groupIcon, css.favoriteIcon)} aria-hidden>
                    <IconStar filled />
                  </span>
                )}
                onToggle={() => { toggleSection('__favorites__') }}
              />

              {expanded && (
                <div className={css.groupBody} id={body} role="group" aria-labelledby={`${body}-header`}>
                  {filteredFavorites.map((fav, fIdx) => {
                    const isSelected = activeSel?.provider === fav.provider && activeSel.model === fav.model.id
                    return (
                      <PickerRow
                        key={`fav-${fav.provider}-${fav.model.id}`}
                        provider={providerName(fav.provider, fav.groupName)}
                        name={fav.model.name}
                        providerTagged={ambiguousKeys.has(modelRowKey(fav.provider, fav.model.id))}
                        selected={isSelected}
                        mode="selectable"
                        leading={!q && (
                          <span className={css.dragHandle} title={t('favorite.dragReorder')} aria-hidden>
                            <IconGrip />
                          </span>
                        )}
                        tags={<ModelCapabilityTags model={fav.model} t={t} />}
                        draggable={!q}
                        onDragStart={(e) => { handleFavoriteDragStart(e, fIdx) }}
                        onDragOver={(e) => { e.preventDefault() }}
                        onDrop={(e) => { handleFavoriteDrop(e, fIdx) }}
                        onSelect={() => { choose({ provider: fav.provider, model: fav.model.id }) }}
                        trailing={(
                          <button
                            type="button"
                            className={clsx(css.starBtn, css.starBtnActive)}
                            title={t('favorite.remove')}
                            aria-label={t('favorite.remove')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelFavorite(fav.provider, fav.model.id)
                              setPrefsVersion(v => v + 1)
                            }}
                          >
                            <IconStar filled />
                          </button>
                        )}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {/* RECENTS GROUP (when not searching) */}
        {!searching && recentItems.length > 0 && (() => {
          const body = bodyId('recents', 0)
          const expanded = !isSectionCollapsed('__recents__')
          return (
            <div className={css.groupSection}>
              <PickerGroupHeader
                id={`${body}-header`}
                bodyId={body}
                title={t('group.recent')}
                count={recentItems.length}
                expanded={expanded}
                icon={(
                  <span className={css.groupIcon} aria-hidden>
                    <IconClock />
                  </span>
                )}
                onToggle={() => { toggleSection('__recents__') }}
              />

              {expanded && (
                <div className={css.groupBody} id={body} role="group" aria-labelledby={`${body}-header`}>
                  {recentItems.map((rec) => {
                    const isSelected = activeSel?.provider === rec.provider && activeSel.model === rec.model.id
                    const isFav = isModelFavorite(rec.provider, rec.model.id)
                    return (
                      <PickerRow
                        key={`rec-${rec.provider}-${rec.model.id}`}
                        provider={providerName(rec.provider, rec.groupName)}
                        name={rec.model.name}
                        providerTagged={ambiguousKeys.has(modelRowKey(rec.provider, rec.model.id))}
                        selected={isSelected}
                        mode="selectable"
                        tags={<ModelCapabilityTags model={rec.model} t={t} />}
                        onSelect={() => { choose({ provider: rec.provider, model: rec.model.id }) }}
                        trailing={(
                          <button
                            type="button"
                            className={clsx(css.starBtn, isFav && css.starBtnActive)}
                            title={isFav ? t('favorite.remove') : t('favorite.add')}
                            aria-label={isFav ? t('favorite.remove') : t('favorite.add')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelFavorite(rec.provider, rec.model.id)
                              setPrefsVersion(v => v + 1)
                            }}
                          >
                            <IconStar filled={isFav} />
                          </button>
                        )}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {/* PROVIDER GROUPS - uses 0ms cached hidden/collapsed checks */}
        {providerSections.map(({ group, visibleModels, hiddenMatches }, index) => {
          const body = bodyId('provider', index)
          const expanded = !isSectionCollapsed(group.id)
          const name = providerName(group.id)
          return (
            <div
              key={group.id}
              className={clsx(css.groupSection, dragOverItem === group.id && css.dragOver)}
              onDragOver={(e) => { handleProviderDragOver(e, group.id) }}
              onDrop={(e) => { handleProviderDrop(e, group.id) }}
            >
              <PickerGroupHeader
                id={`${body}-header`}
                bodyId={body}
                title={name}
                count={visibleModels.length}
                expanded={expanded}
                dragHandle={!searching && (
                  <span
                    className={css.dragHandle}
                    draggable
                    onDragStart={(e) => { handleProviderDragStart(e, group.id) }}
                    title={t('provider.dragReorder')}
                    aria-hidden
                  >
                    <IconGrip />
                  </span>
                )}
                onToggle={() => { toggleSection(group.id) }}
              />

              {expanded && (
                <div className={css.groupBody} id={body} role="group" aria-labelledby={`${body}-header`}>
                  {visibleModels.map((model) => {
                    const isSelected = activeSel?.provider === group.id && activeSel.model === model.id
                    const isFav = isModelFavorite(group.id, model.id)
                    // A manual shown pin that had to override something carries
                    // the engine's reason; a plain pin stays unbadged.
                    const decision = decisionFor(group.id, model.id)
                    const pinnedReason = decision?.state === 'visible' && decision.source === 'manual' && decision.reason !== 'pinned visible'
                      ? decision.reason
                      : undefined
                    return (
                      <PickerRow
                        key={model.id}
                        provider={name}
                        name={model.name}
                        providerTagged={ambiguousKeys.has(modelRowKey(group.id, model.id))}
                        selected={isSelected}
                        mode="selectable"
                        tags={(
                          <>
                            <ModelCapabilityTags model={model} t={t} />
                            {pinnedReason !== undefined && (
                              <span className={css.ruleTag}>{pinnedReason}</span>
                            )}
                          </>
                        )}
                        onSelect={() => { choose({ provider: group.id, model: model.id }) }}
                        trailing={(
                          <button
                            type="button"
                            className={clsx(css.starBtn, isFav && css.starBtnActive)}
                            title={isFav ? t('favorite.remove') : t('favorite.add')}
                            aria-label={isFav ? t('favorite.remove') : t('favorite.add')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelFavorite(group.id, model.id)
                              setPrefsVersion(v => v + 1)
                            }}
                          >
                            <IconStar filled={isFav} />
                          </button>
                        )}
                      />
                    )
                  })}
                  {/* Hidden-by-rule matches surface on an explicit search, dimmed
                      and selectable only through a manual shown pin — the reason
                      stays visible instead of a silent disappearance. */}
                  {hiddenMatches.map((model) => {
                    const reason = decisionFor(group.id, model.id)?.reason
                    return (
                      <PickerRow
                        key={`rule-hidden-${model.id}`}
                        provider={name}
                        name={model.name}
                        providerTagged={ambiguousKeys.has(modelRowKey(group.id, model.id))}
                        selected={false}
                        mode="hidden"
                        tags={(
                          <>
                            <ModelCapabilityTags model={model} t={t} />
                            {reason !== null && reason !== undefined && <span className={css.ruleTag}>{reason}</span>}
                          </>
                        )}
                        title={reason ?? undefined}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Empty search results */}
        {searching && providerSections.length === 0 && filteredFavorites.length === 0 && filteredChainGroups.length === 0 && (
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
            onClick={() => { chooseEffort(level.effort) }}
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
        className={clsx(
          css.modelTrigger,
          pickerOpen && css.modelTriggerActive,
          triggerProvider !== undefined && css.modelTriggerAmbiguous,
        )}
        title={triggerTitle}
        {...currentAmbiguous ? { 'aria-label': `${currentModelName}, ${currentProviderName ?? ''}`.trim() } : {}}
        data-model-trigger
        disabled={locked}
        onClick={(event) => {
          // The sheet mask mounts during this click; stop the native event so
          // the same activation cannot immediately dismiss the surface it opened.
          event.stopPropagation()
          setEffortOpen(false)
          setPickerOpen(!pickerOpen)
        }}
      >
        {activeChain !== undefined && (
          <span className={css.chainTriggerIcon} aria-hidden>
            <IconChain />
          </span>
        )}
        {triggerProvider !== undefined && (
          <span className={css.triggerProvider}>{triggerProvider}</span>
        )}
        <span className={css.modelNameLabel}>
          {activeChain?.label ?? (staleSelection ? modelLabel : currentModelName)}
        </span>
        <span className={clsx(css.chevronIcon, pickerOpen && css.chevronOpen)} aria-hidden>
          <IconChevron />
        </span>
      </button>

      {/* 2. Conditional Reasoning Effort Pill (rendered when the model offers
          levels, or when a saved effort needs the provider-default action). */}
      {effortChoices.length > 0 && (
        <button
          type="button"
          className={clsx(css.effortTrigger, effortOpen && css.effortTriggerActive)}
          title={t('effort.triggerTitle', { effort: effortLabel })}
          data-effort-trigger
          disabled={locked}
          onClick={(event) => {
            event.stopPropagation()
            setPickerOpen(false)
            setEffortOpen(!effortOpen)
          }}
        >
          <span className={css.triggerIcon} aria-hidden>
            <IconBrain />
          </span>
          <span className={css.effortText}>{effortLabel}</span>
          <span className={clsx(css.chevronIcon, effortOpen && css.chevronOpen)} aria-hidden>
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
            onClose={() => { closePicker(false) }}
            title={t('menu.aria')}
            closeLabel={t('menu.close')}
            surfaceId="ui-model-selection:picker"
            contentClassName={css.sheetContent ?? ''}
          >
            {pickerPanel}
          </Sheet>
        )
        : createPortal(
          <MenuSurface
            ref={pickerRef}
            className={css.pickerPopover}
            data-model-popover
            style={{ ...menuPos ?? MEASURE_STYLE, position: 'fixed' }}
            role="dialog"
            aria-label={t('menu.aria')}
            aria-busy={state.status === 'loading' || state.status === 'selecting'}
          >
            {pickerPanel}
          </MenuSurface>,
          document.body,
        ))}

      {/* 4. Compact Effort Level Popover: anchored on desktop, a sheet at
          phone widths. */}
      {effortOpen && effortChoices.length > 0 && (sheetMode
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
          <MenuSurface ref={effortRef} className={css.effortPopover} style={{ position: 'absolute' }}>
            {effortPanel}
          </MenuSurface>
        ))}

      {/* Toast Feedback */}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
