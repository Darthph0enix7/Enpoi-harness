import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { LlmPoolIdentityStatus } from '@deepseek-ai/dsh-llm/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconEye, IconEyeOff, IconTools, IconBrain, IconVision, IconAudio, IconVideo, IconFile,
  IconKey, IconBolt, IconTrash, IconCheck, IconSearch, IconServer,
  IconPlus, IconRefresh, IconArrowUp, IconArrowDown, IconLayers,
} from './capability-icons.tsx'
import {
  toggleModelHidden, hideAllModels, showAllModels,
} from './hidden-models.ts'
import {
  CATALOG_DECISIONS_CHANGED_EVENT, modelVisibility, readCatalogDecisions,
} from './model-visibility.ts'
import { idCapabilityHints } from './capability-hints.ts'
import { deriveKeyRef, messageOf, protocolChoices, type ProviderRow, type ModelsWire } from './store.ts'
import { refreshRouteViaPlugin, type ProviderSyncRefreshView } from './provider-sync-rpc.ts'
import { applyFenced, fencedFailureText } from './fenced-mutate.ts'
import { HeavyProviderCard } from './HeavyProviderCard.tsx'
import { resolveHeavyManifest } from './heavy-manifest-source.ts'
import { providerDashboardUrls } from './provider-templates.ts'
import { OPENAI_BASE_URL_EXAMPLE } from './endpoint-defaults.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Live pool status refresh cadence while the detail panel is mounted. */
const POOL_POLL_INTERVAL_MS = 15_000

export interface ProviderDetailPanelProps {
  row: ProviderRow
  namespace: SettingsNamespaceView
  schema: SettingsSchemaOperations
  api: ModelsWire
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
  readOnly: boolean
  onDelete: () => void
  onSaved: () => void
}

type ModelItem = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: Record<string, unknown>
  reasoning?: boolean | object
  input?: string[]
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  files?: boolean
  /** The listing's own price fields, when the row still carries discovery fields. */
  cost?: unknown
  /** Provider sync marked this model sign-in/paid-only; the eye renders off. */
  gated?: boolean
  /** The listing's own free marker, when the row still carries discovery fields. */
  isFree?: boolean
  /** Picker-facing reason for a gated model; rendered in the eye's tooltip. */
  gateReason?: string
  /**
   * The sync's labeled id-hint claim (the shared table plus any owner
   * override); present only when hints were evaluated for this row. Never a
   * disclosed fact.
   */
  capabilityHints?: {
    input?: string[]
    reasoning?: boolean
    source?: string
  }
  /**
   * The sync marked the capability row as resting on the schema floor rather
   * than a disclosure.
   */
  unverified?: boolean
  /** The sync's provenance stamp (`manual` survives catalog removal). */
  source?: string
  /** The sync kept this row only because something references it; upstream retired it. */
  deprecated?: boolean
  /** When the sync first saw an endpoint-only id, for the 14-day grace. */
  firstSeenAt?: number
}

/**
 * One row of a route's discovered model list. The shared wire type names the
 * minimum; a discovery may disclose capabilities beyond it (modalities,
 * tools, reasoning, price, gate markers), and the merge preserves what the
 * stored row can express instead of dropping it.
 */
interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
  reasoning?: boolean | object
  reasoningEfforts?: Record<string, unknown>
  supported_parameters?: string[]
  tools?: boolean
  cost?: unknown
  gated?: boolean
  gateReason?: string
  isFree?: boolean
}

/** One positive integer route field, or `undefined` when it is not one. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The capability fields one discovered row disclosed, as a stored model row
 * carries them. A field the discovery said nothing about stays out, and a gate
 * reason rides its gate.
 */
function disclosedCapabilities(discovered: DiscoveredModel): Partial<ModelItem> {
  return {
    ...discovered.reasoning === undefined ? {} : { reasoning: discovered.reasoning },
    ...discovered.reasoningEfforts === undefined ? {} : { reasoningEfforts: discovered.reasoningEfforts },
    ...discovered.supported_parameters === undefined ? {} : { supported_parameters: discovered.supported_parameters },
    ...discovered.tools === undefined ? {} : { tools: discovered.tools },
    ...discovered.cost === undefined ? {} : { cost: discovered.cost },
    ...discovered.gated === true ? { gated: true } : {},
    ...discovered.gated === true && discovered.gateReason !== undefined ? { gateReason: discovered.gateReason } : {},
    ...discovered.isFree === undefined ? {} : { isFree: discovered.isFree },
  }
}

/**
 * Merge one discovery answer into a route's configured models without
 * deleting any: an advertised id refreshes the fields the answer disclosed
 * while keeping every per-id field the answer did not mention, an id the
 * answer omits stays exactly as configured, and an id configuration does not
 * name is appended. An undisclosed capacity falls back to the route's
 * configured default, then stays absent so the adapter's own default applies
 * at resolution — the panel never invents a number.
 * @param configured - the route's current `models` array.
 * @param discovered - one discovery answer, in endpoint order.
 * @param capacityDefaults - the route profile's fallback capacities
 *   (`defaultContextWindow` / `defaultMaxTokens`); unusable values are ignored.
 * @returns the merged list, configured entries first.
 */
export function mergeRefreshedModels(
  configured: readonly ModelItem[],
  discovered: readonly DiscoveredModel[],
  capacityDefaults: { contextWindow?: unknown; maxTokens?: unknown } = {},
): ModelItem[] {
  const contextFallback = positiveInteger(capacityDefaults.contextWindow)
  const maxTokensFallback = positiveInteger(capacityDefaults.maxTokens)
  const advertised = new Map<string, DiscoveredModel>()
  for (const model of discovered) {
    if (advertised.has(model.id)) continue
    advertised.set(model.id, model)
  }
  const merged: ModelItem[] = []
  const seen = new Set<string>()
  for (const model of configured) {
    const id = typeof model.id === 'string' && model.id.length > 0 ? model.id : undefined
    if (id === undefined) {
      merged.push(model)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const fresh = advertised.get(id)
    if (fresh === undefined) {
      merged.push(model)
      continue
    }
    const contextWindow = fresh.contextWindow ?? model.contextWindow ?? contextFallback
    const maxTokens = fresh.maxTokens ?? model.maxTokens ?? maxTokensFallback
    merged.push({
      ...model,
      name: fresh.name !== undefined && fresh.name !== fresh.id ? fresh.name : model.name ?? fresh.id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...model.input === undefined && fresh.inputModalities !== undefined && fresh.inputModalities.length > 0
        ? { input: [...fresh.inputModalities] } : {},
      ...disclosedCapabilities(fresh),
    })
  }
  for (const model of discovered) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const contextWindow = model.contextWindow ?? contextFallback
    const maxTokens = model.maxTokens ?? maxTokensFallback
    merged.push({
      id: model.id,
      name: model.name !== undefined && model.name !== model.id ? model.name : model.id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...model.inputModalities === undefined || model.inputModalities.length === 0
        ? {} : { input: [...model.inputModalities] },
      ...disclosedCapabilities(model),
    })
  }
  return merged
}

/**
 * Apply one host refresh answer to the route's current models with replace
 * semantics: the answer is the base, and a current row absent from it is kept
 * unless the host named its id in `removed`. The host's removal list is the
 * sole deletion gate, so an omitted row the host never reported — a row the
 * panel is still drafting, or one another writer added mid-refresh — survives
 * with its own fields and stamp, while a `source: 'manual'` row keeps its
 * stamp either way.
 * @param current - the route's models as the panel currently holds them.
 * @param answer - the host pipeline's planned records.
 * @param removed - the ids the host reported as removed.
 * @returns the list to persist (the answer, plus surviving current rows).
 */
export function applyRefreshedModels(
  current: readonly ModelItem[],
  answer: readonly Record<string, unknown>[],
  removed: readonly string[],
): Array<Record<string, unknown>> {
  const answerIds = new Set(answer.map(model => (typeof model.id === 'string' ? model.id : '')))
  const removedIds = new Set(removed)
  const survivors = current.filter(model => !answerIds.has(model.id) && !removedIds.has(model.id))
  return [...answer, ...survivors]
}

/**
 * The toast for one host refresh answer: the pruned and deprecated counts the
 * pass reports, or the withheld-removal warning when the pass degraded.
 * @param t - the panel translate.
 * @param report - the host refresh answer.
 * @param count - the resulting model count.
 * @returns the toast text.
 */
function refreshReportText(
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
  report: ProviderSyncRefreshView,
  count: number,
): string {
  return report.degraded
    ? t('refreshedModelsDegraded', { count, reason: report.degradedReason ?? t('refreshDegradedUnknown') })
    : t('refreshedModelsReport', { count, removed: report.removed.length, deprecated: report.deprecated.length })
}

/** Which badges rest on the shared id-hint table rather than a disclosure. */
interface HintedBadges {
  reasoning: boolean
  vision: boolean
  audio: boolean
  video: boolean
  files: boolean
  tools: boolean
}

/** One model row's capability badges plus each badge's provenance. */
interface CapabilityView {
  hasReasoning: boolean
  hasVision: boolean
  hasAudio: boolean
  hasVideo: boolean
  hasFiles: boolean
  hasTools: boolean
  hinted: HintedBadges
}

/**
 * Detect the capability badges one model row renders.
 *
 * Data-first: `input` / `architecture.input_modalities` is authoritative, and
 * an explicit `vision`/`audio`/`video`/`files`/`tools` flag or a boolean
 * `reasoning` is a disclosed fact the hints never override. For a capability
 * nothing disclosed, the shared id table (or the sync's override-applied
 * `capabilityHints` field, which wins when present) supplies a HINT: the
 * badge renders with the hint treatment and is never read as truth.
 */
function detectCapabilities(model: ModelItem): CapabilityView {
  const id = (model.id || '').toLowerCase()
  const inputs: string[] = Array.isArray(model.input)
    ? model.input
    : Array.isArray(model.architecture?.input_modalities)
      ? model.architecture.input_modalities
      : []
  const hasStructured = inputs.length > 0

  // The persisted `capabilityHints` field is the sync's override-applied hint
  // set and wins over the shipped table. Client inference runs only when the
  // row carries no structured input and the sync left no labeled hints; stored
  // hints also apply beside the sync's floor `input: ['text']`, because that
  // floor is not a disclosure of absence. The id-level exclusion list stays
  // shipped: the owner override does not carry a tools family.
  const stored = model.capabilityHints
  const idHints = idCapabilityHints(id)
  const computed = stored === undefined && !hasStructured ? idHints : undefined
  const hintInputs: readonly string[] = stored?.input ?? computed?.input ?? []
  const hintedReasoning = stored?.reasoning ?? computed?.reasoning ?? false
  const hintedVision = hintInputs.includes('image')
  const hintedAudio = hintInputs.includes('audio')
  const hintedVideo = hintInputs.includes('video')
  const hintedFiles = hintInputs.includes('pdf')

  // 1. REASONING / THINKING — an explicit boolean/object/efforts/parameters
  // fact wins. `false` beside a stored hint set is the sync's schema floor,
  // not a disclosure of absence, so it yields to the hint; without stored
  // hints it is a disclosure and blocks the heuristics.
  const reasoningFact: boolean | undefined =
    typeof model.reasoning === 'boolean' ? model.reasoning
      : typeof model.reasoning === 'object' && model.reasoning !== null ? true
        : model.reasoningEfforts !== undefined ? true
          : model.supported_parameters?.includes('reasoning')
            || model.supported_parameters?.includes('reasoning_effort')
            || model.supported_parameters?.includes('include_reasoning')
            ? true
            : undefined
  const disclosedReasoningFact = reasoningFact === false && stored !== undefined ? undefined : reasoningFact
  const hasReasoning = disclosedReasoningFact ?? hintedReasoning
  const reasoningHinted = disclosedReasoningFact === undefined && hintedReasoning

  // 2. VISION / IMAGE INPUT
  const visionFact = model.vision ?? (hasStructured && (inputs.includes('image') || inputs.includes('vision')) ? true : undefined)
  const hasVision = visionFact ?? hintedVision
  const visionHinted = visionFact === undefined && hintedVision

  // 3. AUDIO INPUT
  const audioFact = model.audio ?? (hasStructured && (inputs.includes('audio') || inputs.includes('voice')) ? true : undefined)
  const hasAudio = audioFact ?? hintedAudio
  const audioHinted = audioFact === undefined && hintedAudio

  // 4. VIDEO INPUT
  const videoFact = model.video ?? (hasStructured && inputs.includes('video') ? true : undefined)
  const hasVideo = videoFact ?? hintedVideo
  const videoHinted = videoFact === undefined && hintedVideo

  // 5. TOOL CALLING — a disclosed tools flag wins; otherwise the badge is the
  // shared list's default (on, minus the exclusion operands), and a hint.
  const toolsFact = model.tools ?? (model.supported_parameters?.includes('tools') ? true : undefined)
  const hasTools = toolsFact ?? !idHints.toolsExcluded
  const toolsHinted = toolsFact === undefined

  // 6. DOCUMENTS & FILES (native document parsing, not general text context)
  const filesFact = model.files ?? (hasStructured && (inputs.includes('file') || inputs.includes('pdf') || inputs.includes('document')) ? true : undefined)
  const hasFiles = filesFact ?? hintedFiles
  const filesHinted = filesFact === undefined && hintedFiles

  return {
    hasReasoning,
    hasVision,
    hasAudio,
    hasVideo,
    hasFiles,
    hasTools,
    hinted: {
      reasoning: reasoningHinted,
      vision: visionHinted,
      audio: audioHinted,
      video: videoHinted,
      files: filesHinted,
      tools: toolsHinted,
    },
  }
}

function formatTokens(count?: number): string {
  if (!count || count <= 0) return ''
  if (count >= 1_000_000) {
    const m = count / 1_000_000
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (count >= 1_000) {
    const k = count / 1_000
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1).replace(/\.?0+$/, '')}K`
  }
  return String(count)
}

// 0ms pool: weak-cache caps per model object so 500× detectCapabilities is O(1) on re-switch
const capsWeakCache = new WeakMap<ModelItem, ReturnType<typeof detectCapabilities>>()
function getCapsCached(model: ModelItem): ReturnType<typeof detectCapabilities> {
  let c = capsWeakCache.get(model)
  if (!c) {
    c = detectCapabilities(model)
    capsWeakCache.set(model, c)
  }
  return c
}

/** One provider's stored key-pool value, as the panel reads and edits it. */
type PoolShape = {
  strategy?: string
  identities?: Array<{ id: string; credentialRef: string; priority?: number; enabled?: boolean }>
} | undefined

/** Whether two stored pools carry the same strategy and ordered identity rows. */
function samePool(left: PoolShape, right: PoolShape): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.strategy !== right.strategy) return false
  const leftRows = left.identities ?? []
  const rightRows = right.identities ?? []
  if (leftRows.length !== rightRows.length) return false
  return leftRows.every((entry, index) => {
    const other = rightRows[index]
    return other !== undefined && entry.id === other.id && entry.credentialRef === other.credentialRef
      && entry.priority === other.priority && entry.enabled === other.enabled
  })
}

/** 0ms hidden-map reader: parse once per prefsVersion like ModelSelect */
function readHiddenMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem('dsh_hidden_models_v1')
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string[]>
  } catch { return {} }
}

export function ProviderDetailPanel(props: ProviderDetailPanelProps): ReactNode {
  const { row, namespace, schema, api, t, readOnly, onDelete, onSaved } = props
  const providerId = row.entry.provider
  const isDeclared = row.entry.declared === true

  // Raw profile from settings
  const rawProfile = useMemo(() => {
    return (schema.getPath(namespace.user, row.entry.settingsPath) ??
      schema.getPath(namespace.value, row.entry.settingsPath) ??
      {}) as Record<string, unknown>
  }, [namespace, row.entry.settingsPath, schema])

  // The fenced write plans re-read the live document per attempt: these read
  // one fresh described view with the same precedence as the render's own
  // snapshot, so each retry re-applies the operator's draft onto current data.
  const profileAt = useCallback((view: SettingsNamespaceView | undefined): Record<string, unknown> => {
    return (schema.getPath(view?.user, row.entry.settingsPath) ??
      schema.getPath(view?.value, row.entry.settingsPath) ??
      {}) as Record<string, unknown>
  }, [row.entry.settingsPath, schema])
  /** The canonical pool out of one fresh profile, matching the serverPool read. */
  const poolAt = useCallback((view: SettingsNamespaceView | undefined): PoolShape => {
    const p = profileAt(view)['pool'] as PoolShape
    return p && Array.isArray(p.identities) ? p : undefined
  }, [profileAt])
  /** The models list out of one fresh profile, matching the modelsList read. */
  const modelsAt = useCallback((view: SettingsNamespaceView | undefined): ModelItem[] => {
    const list = profileAt(view)['models']
    return Array.isArray(list) ? list as ModelItem[] : []
  }, [profileAt])

  // State
  const [displayName, setDisplayName] = useState<string>(
    typeof rawProfile.displayName === 'string' ? rawProfile.displayName : row.entry.displayName,
  )
  const [baseURL, setBaseURL] = useState<string>(
    typeof rawProfile.baseURL === 'string' ? rawProfile.baseURL : '',
  )
  const [protocol, setProtocol] = useState<string>(
    typeof rawProfile.api === 'string' ? rawProfile.api : 'openai-completions',
  )
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyState, setKeyState] = useState<CredentialInfo | undefined>(
    row.credential ?? row.derivedCredential,
  )
  const [modelSearch, setModelSearch] = useState('')
  // 0ms hidden cache: like ModelSelect, parse once per prefsVersion, not per click
  const [prefsVersion, setPrefsVersion] = useState(0)
  useEffect(() => {
    const bump = () => setPrefsVersion(v => v + 1)
    window.addEventListener('dsh:hidden-models-changed', bump)
    window.addEventListener('dsh:model-picker-prefs-changed', bump)
    // The picker's published rule decisions ride their own event; the eye must
    // follow them or it would state a visibility the picker does not show.
    window.addEventListener(CATALOG_DECISIONS_CHANGED_EVENT, bump)
    window.addEventListener('storage', bump)
    return () => {
      window.removeEventListener('dsh:hidden-models-changed', bump)
      window.removeEventListener('dsh:model-picker-prefs-changed', bump)
      window.removeEventListener(CATALOG_DECISIONS_CHANGED_EVENT, bump)
      window.removeEventListener('storage', bump)
    }
  }, [])
  const hiddenMap = useMemo(() => readHiddenMap(), [prefsVersion])
  const hiddenSets = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [k, v] of Object.entries(hiddenMap)) if (Array.isArray(v)) m.set(k, new Set(v))
    return m
  }, [hiddenMap])
  const hiddenSet = useMemo(() => hiddenSets.get(providerId) ?? new Set<string>(), [hiddenSets, providerId])
  // The picker's own decision mirror, so a gated or rule-hidden model shows the
  // same eye state the picker renders. The route row's own data is the fallback
  // when no host engine published decisions.
  const catalogDecisions = useMemo(() => readCatalogDecisions(), [prefsVersion])
  const [testStatus, setTestStatus] = useState<{
    state: 'idle' | 'testing' | 'success' | 'error'
    message?: string
    latencyMs?: number
    modelCount?: number
  }>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  // Toast timers are owned by the panel: a switch or unmount clears them
  // instead of leaving a detached timeout to set state on a dead tree.
  const saveClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pool State
  const serverPool = useMemo<PoolShape>(() => {
    const p = rawProfile.pool as PoolShape
    return p && Array.isArray(p.identities) ? p : undefined
  }, [rawProfile.pool])

  const [localPool, setLocalPool] = useState<PoolShape>(serverPool)

  // Reconcile against the stored pool VALUE, not the object identity a settings
  // echo republishes: an unrelated write (or our own hidden-model toggle) must
  // not reset an in-progress pool edit. Only a moved pool applies.
  const lastServerPool = useRef<PoolShape>(serverPool)
  useEffect(() => {
    const previous = lastServerPool.current
    lastServerPool.current = serverPool
    if (samePool(previous, serverPool)) return
    setLocalPool(serverPool)
  }, [serverPool])

  const poolConfig = localPool

  const [poolStatusList, setPoolStatusList] = useState<LlmPoolIdentityStatus[]>([])
  const [isPoolLoading, setIsPoolLoading] = useState(false)
  const [identityTestResults, setIdentityTestResults] = useState<Record<string, { state: 'testing' | 'success' | 'error' | 'unavailable'; message?: string; latencyMs?: number }>>({})
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [newKeyId, setNewKeyId] = useState('')
  const [newKeyRef, setNewKeyRef] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [newKeyPriority, setNewKeyPriority] = useState<number>(1)
  const [newKeyShow, setNewKeyShow] = useState(false)

  // Fetch live pool status from host — fire-and-forget, never blocks provider switch (0ms optimistic)
  const fetchPoolStatus = useCallback(async () => {
    try {
      const pool = (api.llm as unknown as { poolStatus?: (ns: string, p: string) => Promise<unknown> }).poolStatus
      if (typeof pool !== 'function') return
      const res: unknown = await pool.call(api.llm, namespace.ns, providerId)
      if (Array.isArray(res)) {
        setPoolStatusList(res as LlmPoolIdentityStatus[])
      } else if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
        const r = res as { ok: boolean; value?: LlmPoolIdentityStatus[]; error?: { message: string } }
        if (r.ok && Array.isArray(r.value)) setPoolStatusList(r.value)
      } else if (res && typeof res === 'object' && 'result' in (res as Record<string, unknown>)) {
        const r = res as { result: { ok: boolean; value?: { identities?: LlmPoolIdentityStatus[] } } }
        if (r.result.ok) setPoolStatusList(r.result.value?.identities || [])
      }
    } catch {
      // Ignored if host or route has no active pool engine
    } finally {
      setIsPoolLoading(false)
    }
  }, [api.llm, namespace.ns, providerId])

  useEffect(() => {
    void fetchPoolStatus()
    const timer = setInterval(() => { void fetchPoolStatus() }, POOL_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchPoolStatus])

  // Protocols
  const protocols = useMemo(() => protocolChoices(namespace, schema), [namespace, schema])

  // Key ref
  const keyRef = useMemo(() => {
    return typeof rawProfile.apiKeyEnv === 'string' && rawProfile.apiKeyEnv.length > 0
      ? rawProfile.apiKeyEnv
      : deriveKeyRef(providerId)
  }, [providerId, rawProfile.apiKeyEnv])

  // Per-provider transient state resets only when the route itself changes: a
  // settings echo (a fresh namespace identity from the store) must not clear
  // the model search, a typed key, or a test result.
  useEffect(() => {
    setKeyInput('')
    setTestStatus({ state: 'idle' })
    setSaveSuccess(false)
    setModelSearch('')
  }, [providerId])

  // The page re-joins credentials on every load; the badge must follow the
  // latest describe answer instead of keeping the first render's claim.
  useEffect(() => {
    setKeyState(row.credential ?? row.derivedCredential)
  }, [providerId, row.credential, row.derivedCredential])

  // Server reconciliation for the stored profile fields: apply the server
  // value only when it actually moved, so a no-op echo cannot clobber an
  // in-progress edit (the pool editor's optimistic-local pattern).
  const lastServerProfile = useRef<{ displayName: string; baseURL: string; protocol: string } | null>(null)
  useEffect(() => {
    const next = {
      displayName: typeof rawProfile.displayName === 'string' ? rawProfile.displayName : row.entry.displayName,
      baseURL: typeof rawProfile.baseURL === 'string' ? rawProfile.baseURL : '',
      protocol: typeof rawProfile.api === 'string' ? rawProfile.api : 'openai-completions',
    }
    const previous = lastServerProfile.current
    if (previous !== null
      && previous.displayName === next.displayName
      && previous.baseURL === next.baseURL
      && previous.protocol === next.protocol) return
    lastServerProfile.current = next
    setDisplayName(next.displayName)
    setBaseURL(next.baseURL)
    setProtocol(next.protocol)
  }, [rawProfile, row.entry.displayName])

  // Models list
  const modelsList = useMemo<ModelItem[]>(() => {
    const list = rawProfile.models
    if (Array.isArray(list) && list.length > 0) {
      return list as ModelItem[]
    }
    return []
  }, [rawProfile.models])

  // The route's model ids, stable across unrelated renders: the heavy card's
  // automatic-population decision watches this list.
  const modelIdList = useMemo(() => modelsList.map(model => model.id), [modelsList])

  // Filtered models
  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase().trim()
    if (!q) return modelsList
    return modelsList.filter((m) => {
      const name = (m.name || '').toLowerCase()
      const id = (m.id || '').toLowerCase()
      return name.includes(q) || id.includes(q)
    })
  }, [modelSearch, modelsList])

  // 0ms: enrich once per filtered list; caps cached via WeakMap so 500× string scans O(1) on re-switch
  const enrichedFilteredModels = useMemo(() => {
    return filteredModels.map(m => ({
      model: m,
      visibility: modelVisibility(m, hiddenSet, catalogDecisions.get(`${providerId}/${m.id}`)),
      caps: getCapsCached(m),
      contextStr: formatTokens(m.contextWindow),
      maxTokStr: formatTokens(m.maxTokens),
    }))
  }, [filteredModels, hiddenSet, catalogDecisions, providerId])

  // Toggle model hidden
  // 0ms optimistic hide toggles: write store + bump prefsVersion so hiddenMap memo updates synchronously
  const handleToggleHide = (modelId: string) => {
    toggleModelHidden(providerId, modelId)
    setPrefsVersion(v => v + 1)
  }

  // Bulk hide/show
  const handleHideAll = () => {
    const allIds = modelsList.map(m => m.id)
    hideAllModels(providerId, allIds)
    setPrefsVersion(v => v + 1)
  }

  const handleShowAll = () => {
    showAllModels(providerId)
    setPrefsVersion(v => v + 1)
  }

  // Test Connection
  const handleTestConnection = async () => {
    setTestStatus({ state: 'testing' })
    const startTime = performance.now()
    try {
      const res = await api.llm.discoverModels(namespace.ns, {
        provider: providerId,
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        api: protocol,
        ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
      })
      const latencyMs = Math.round(performance.now() - startTime)
      if (res.ok) {
        const count = (res.value as unknown[] | undefined)?.length ?? 0
        setTestStatus({
          state: 'success',
          message: t('connectedModels', { count }),
          latencyMs,
          modelCount: count,
        })
      } else {
        setTestStatus({
          state: 'error',
          message: res.error.message,
          latencyMs,
        })
      }
    } catch (err) {
      setTestStatus({
        state: 'error',
        message: messageOf(err),
      })
    }
  }

  // Refresh Models live from endpoint
  const [refreshState, setRefreshState] = useState<{ isRefreshing: boolean; message?: string; isError?: boolean }>({
    isRefreshing: false,
  })
  const catalogRefreshInFlight = useRef(false)

  // The toast auto-clear is one owned timer: a later toast replaces the
  // pending clear, and unmount cancels whatever is still armed.
  const scheduleRefreshClear = useCallback((ms: number): void => {
    if (refreshClearTimer.current !== null) clearTimeout(refreshClearTimer.current)
    refreshClearTimer.current = setTimeout(() => {
      refreshClearTimer.current = null
      setRefreshState({ isRefreshing: false })
    }, ms)
  }, [])
  useEffect(() => () => {
    if (saveClearTimer.current !== null) clearTimeout(saveClearTimer.current)
    if (refreshClearTimer.current !== null) clearTimeout(refreshClearTimer.current)
  }, [])

  /**
   * Refresh the route's models through the removal-aware host pipeline when
   * the provider-sync plugin is mounted: the answer replaces the route's
   * provider-sourced models (an id the host removed disappears), every current
   * row the answer omits but the host did not report removed survives, and the
   * toast reports the pruned/deprecated/degraded outcome. The fenced settings
   * write persists it. When the RPC is unavailable (plugin not mounted,
   * offline) the surface falls back to discovery with the legacy merge, which
   * never deletes.
   * Returns whether the write left the route with any model at all; an
   * in-flight refresh, a read-only surface, an empty route with an empty
   * listing, or any discovery/write failure answers false, so the automatic
   * caller may try again on the next health snapshot. The automatic path
   * passes `silent`, which keeps the plain discovery merge (no removals) and
   * suppresses the failure message.
   */
  const runCatalogRefresh = useCallback(async (options: { silent?: boolean } = {}): Promise<boolean> => {
    if (catalogRefreshInFlight.current || readOnly) return false
    catalogRefreshInFlight.current = true
    if (options.silent !== true) setRefreshState({ isRefreshing: true })
    try {
      if (options.silent !== true) {
        const hosted = await refreshRouteViaPlugin(providerId)
        if (hosted.ok) {
          const report = hosted.value
          let count = 0
          const outcome = await applyFenced(api, namespace.ns, (view) => {
            const merged = applyRefreshedModels(modelsAt(view), report.models, report.removed)
            count = merged.length
            return {
              ops: [{ op: 'set', path: [...row.entry.settingsPath, 'models'], value: merged as unknown as JsonValue }],
            }
          })
          if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
          setRefreshState({ isRefreshing: false, message: refreshReportText(t, report, count), isError: false })
          scheduleRefreshClear(4000)
          onSaved()
          return count > 0
        }
      }
      const res = await api.llm.discoverModels(namespace.ns, {
        provider: providerId,
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        api: protocol,
        ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
      })
      if (res.ok) {
        const discovered = (res.value as DiscoveredModel[] | undefined) || []
        let count = 0
        const outcome = await applyFenced(api, namespace.ns, (view) => {
          const fresh = profileAt(view)
          // Merge, never replace: a Refresh may add and update models, but
          // deleting one is the operator's decision, not a listing's.
          const merged = mergeRefreshedModels(modelsAt(view), discovered, {
            contextWindow: fresh.defaultContextWindow,
            maxTokens: fresh.defaultMaxTokens,
          })
          count = merged.length
          return {
            ops: [{ op: 'set', path: [...row.entry.settingsPath, 'models'], value: merged as unknown as JsonValue }],
          }
        })
        if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
        setRefreshState({ isRefreshing: false, message: t('refreshedModels', { count }), isError: false })
        scheduleRefreshClear(4000)
        onSaved()
        return count > 0
      }
      throw new Error(res.error.message)
    } catch (err) {
      // An automatic pass is fail-soft and silent: the next successful status
      // check retries, and the manual Refresh still reports the error.
      if (options.silent !== true) {
        setRefreshState({
          isRefreshing: false,
          message: t('refreshFailed', { message: messageOf(err) }),
          isError: true,
        })
        scheduleRefreshClear(5000)
      }
      return false
    } finally {
      catalogRefreshInFlight.current = false
    }
  }, [
    api, baseURL, keyInput, modelsAt, namespace.ns, onSaved, profileAt,
    providerId, protocol, readOnly, row.entry.settingsPath, scheduleRefreshClear, t,
  ])

  const handleRefreshModels = (): void => { void runCatalogRefresh() }

  // The heavy card's automatic pass: silent on failure, success still reports
  // the count and reloads the settings view.
  const autoPopulate = useCallback(() => runCatalogRefresh({ silent: true }), [runCatalogRefresh])

  // Save Settings / API Key
  const handleSave = async () => {
    setBusy(true)
    setSaveSuccess(false)
    try {
      const cleanKey = keyInput.trim()
      if (cleanKey.length > 0) {
        const credRes = await api.credentials.set(keyRef, cleanKey)
        if (!credRes.ok) {
          throw new Error(credRes.error.message)
        }
        setKeyState({ configured: true, writable: true })
      }

      // Leaf writes only: each fenced attempt re-applies this draft onto a
      // freshly read document, so fields the operator did not touch (headers,
      // models, a concurrent writer's edit) are never replayed from a stale
      // whole-profile snapshot.
      const outcome = await applyFenced(api, namespace.ns, () => {
        const ops: SettingsPathOpView[] = [
          { op: 'set', path: [...row.entry.settingsPath, 'displayName'], value: displayName.trim() || providerId },
        ]
        if (baseURL.trim()) ops.push({ op: 'set', path: [...row.entry.settingsPath, 'baseURL'], value: baseURL.trim() })
        if (protocol) ops.push({ op: 'set', path: [...row.entry.settingsPath, 'api'], value: protocol })
        if (cleanKey.length > 0) ops.push({ op: 'set', path: [...row.entry.settingsPath, 'apiKeyEnv'], value: keyRef })
        return { ops }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))

      setKeyInput('')
      setSaveSuccess(true)
      if (saveClearTimer.current !== null) clearTimeout(saveClearTimer.current)
      saveClearTimer.current = setTimeout(() => {
        saveClearTimer.current = null
        setSaveSuccess(false)
      }, 3000)
      onSaved()
    } catch (err) {
      alert(t('saveFailedAlert', { message: messageOf(err) }))
    } finally {
      setBusy(false)
    }
  }

  // Persist one host identity-test answer. Status 501 is the provider's
  // structured "not implemented" signal: the capability is unavailable rather
  // than the credential failing, so the row renders a disabled explanatory
  // state instead of a red failure.
  const submitIdentityTest = (
    identityId: string,
    answer: { ok: boolean; status?: number; latencyMs?: number; error?: string },
  ): void => {
    const unavailable = answer.status === 501
    setIdentityTestResults(prev => ({
      ...prev,
      [identityId]: answer.ok
        ? {
          state: 'success',
          ...answer.latencyMs === undefined ? {} : { latencyMs: answer.latencyMs },
          message: answer.latencyMs === undefined ? t('poolTestOk') : t('poolTestOkMs', { ms: answer.latencyMs }),
        }
        : {
          state: unavailable ? 'unavailable' : 'error',
          message: answer.error ?? t('poolTestFailed'),
        },
    }))
  }

  // Pool Handlers
  const handleTestIdentity = async (identityId: string, _credentialRef: string) => {
    setIdentityTestResults(prev => ({
      ...prev,
      [identityId]: { state: 'testing' },
    }))
    try {
      const poolTest = (api.llm as unknown as {
        poolTestIdentity?: (ns: string, p: string, id: string, key?: string) => Promise<unknown>
      }).poolTestIdentity
      if (typeof poolTest !== 'function') throw new Error('poolTestIdentity not available')
      const raw: unknown = await poolTest.call(api.llm, namespace.ns, providerId, identityId)
      // Unwrap RemoteResult if present
      if (raw && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
        const outer = raw as { ok: boolean; value?: unknown; error?: { message: string } }
        if (outer.ok) {
          const inner = outer.value as { ok: boolean; status?: number; latencyMs?: number; error?: string } | undefined
          submitIdentityTest(identityId, inner ?? { ok: false })
        } else {
          submitIdentityTest(identityId, { ok: false, error: outer.error?.message ?? 'Test failed' })
        }
      } else if (raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)) {
        const rr = (raw as {
          result: { ok: boolean; value?: { ok: boolean; status?: number; latencyMs?: number; error?: string }; error?: { message: string } }
        }).result
        if (rr.ok) submitIdentityTest(identityId, rr.value ?? { ok: false })
        else submitIdentityTest(identityId, { ok: false, error: rr.error?.message ?? 'Test failed' })
      } else {
        submitIdentityTest(
          identityId,
          (raw as { ok: boolean; status?: number; latencyMs?: number; error?: string } | undefined) ?? { ok: false },
        )
      }
    } catch (err) {
      setIdentityTestResults(prev => ({
        ...prev,
        [identityId]: {
          state: 'error',
          message: messageOf(err),
        },
      }))
    }
    void fetchPoolStatus()
  }

  // The identity test is a namespace-wide operation: one 501 answer disables
  // every identity's test button for this route and keeps the host's
  // explanatory message as the tooltip and the card note.
  const identityTestUnavailable = useMemo(
    () => Object.values(identityTestResults).find(result => result.state === 'unavailable'),
    [identityTestResults],
  )

  const handleResetCooldown = async (identityId?: string) => {
    // 0ms instant optimistic status update: clear cooldown locally
    setPoolStatusList(prev => prev.map((s) => {
      if (!identityId || s.id === identityId) {
        return { ...s, cooldownUntil: 0 }
      }
      return s
    }))

    try {
      const poolReset = (api.llm as unknown as {
        poolResetCooldown?: (ns: string, p: string, id?: string) => Promise<unknown>
      }).poolResetCooldown
      if (typeof poolReset === 'function') {
        if (identityId) await poolReset.call(api.llm, namespace.ns, providerId, identityId)
        else await poolReset.call(api.llm, namespace.ns, providerId)
      }
      void fetchPoolStatus()
    } catch (err) {
      alert(t('resetCooldownFailedAlert', { message: messageOf(err) }))
    }
  }

  const handleToggleIdentityEnabled = async (identityId: string) => {
    if (!poolConfig?.identities || readOnly) return
    const prev = poolConfig
    const nextIdentities = poolConfig.identities.map((i) => {
      if (i.id === identityId) {
        return { ...i, enabled: i.enabled === false }
      }
      return i
    })
    const nextPool = { ...poolConfig, identities: nextIdentities }

    // 0ms instant optimistic update
    setLocalPool(nextPool)

    try {
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        const identities = poolAt(view)?.identities
        if (identities === undefined || !identities.some(i => i.id === identityId)) return { ops: [] }
        const updated = identities.map(i => i.id === identityId ? { ...i, enabled: i.enabled === false } : i)
        return {
          ops: [{ op: 'set', path: [...row.entry.settingsPath, 'pool', 'identities'], value: updated as unknown as JsonValue }],
        }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
      onSaved()
      void fetchPoolStatus()
    } catch (err) {
      setLocalPool(prev)
      alert(t('updateFailedAlert', { message: messageOf(err) }))
    }
  }

  const handleStrategyChange = async (strategy: string) => {
    if (!poolConfig || readOnly) return
    const prev = poolConfig
    const nextPool = { ...poolConfig, strategy }

    // 0ms instant optimistic update
    setLocalPool(nextPool)

    try {
      const outcome = await applyFenced(api, namespace.ns, () => ({
        ops: [{ op: 'set', path: [...row.entry.settingsPath, 'pool', 'strategy'], value: strategy as unknown as JsonValue }],
      }))
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
      onSaved()
    } catch (err) {
      setLocalPool(prev)
      alert(t('strategyChangeFailedAlert', { message: messageOf(err) }))
    }
  }

  const handleMoveIdentity = async (index: number, direction: -1 | 1) => {
    if (!poolConfig?.identities || readOnly) return
    const targetIdx = index + direction
    if (targetIdx < 0 || targetIdx >= poolConfig.identities.length) return
    const prev = poolConfig
    const list = [...poolConfig.identities]
    const item = list[index]
    if (!item) return
    list.splice(index, 1)
    list.splice(targetIdx, 0, item)
    // Update priorities according to new order
    const updatedIdentities = list.map((idObj, idx) => ({ ...idObj, priority: idx + 1 }))
    const nextPool = { ...poolConfig, identities: updatedIdentities }

    // 0ms instant optimistic update
    setLocalPool(nextPool)

    try {
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        const identities = poolAt(view)?.identities
        if (identities === undefined) return { ops: [] }
        // The draft is "move this identity one step"; the fresh order decides
        // the indexes, so a concurrent reorder applies the move where the
        // identity actually sits now.
        const from = identities.findIndex(i => i.id === item.id)
        const to = from + direction
        if (from < 0 || to < 0 || to >= identities.length) return { ops: [] }
        const moved = [...identities]
        const [entry] = moved.splice(from, 1)
        if (entry === undefined) return { ops: [] }
        moved.splice(to, 0, entry)
        const renumbered = moved.map((identity, position) => ({ ...identity, priority: position + 1 }))
        return {
          ops: [{ op: 'set', path: [...row.entry.settingsPath, 'pool', 'identities'], value: renumbered as unknown as JsonValue }],
        }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
      onSaved()
      void fetchPoolStatus()
    } catch (err) {
      setLocalPool(prev)
      alert(t('reorderFailedAlert', { message: messageOf(err) }))
    }
  }

  const handleDeleteIdentity = async (identityId: string) => {
    if (!poolConfig?.identities || readOnly) return
    if (!confirm(t('removeIdentityConfirm', { id: identityId }))) return
    const prev = poolConfig
    const remaining = poolConfig.identities.filter(i => i.id !== identityId)

    // 0ms instant optimistic update
    setLocalPool(remaining.length > 0 ? { ...poolConfig, identities: remaining } : undefined)

    try {
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        const identities = poolAt(view)?.identities
        if (identities === undefined) return { ops: [] }
        const kept = identities.filter(i => i.id !== identityId)
        // The identity is already gone: the previous attempt committed.
        if (kept.length === identities.length) return { ops: [] }
        if (kept.length === 0) return { ops: [{ op: 'unset', path: [...row.entry.settingsPath, 'pool'] }] }
        return {
          ops: [{ op: 'set', path: [...row.entry.settingsPath, 'pool', 'identities'], value: kept as unknown as JsonValue }],
        }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
      onSaved()
      void fetchPoolStatus()
    } catch (err) {
      setLocalPool(prev)
      alert(t('deleteFailedAlert', { message: messageOf(err) }))
    }
  }

  const handleAddIdentitySubmit = async () => {
    const id = newKeyId.trim()
    const ref = newKeyRef.trim() || `${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_KEY_${Date.now().toString().slice(-4)}`
    const val = newKeyValue.trim()
    if (!id || !val) {
      alert(t('identityRequiredAlert'))
      return
    }
    setBusy(true)
    const prev = poolConfig
    const currentList = poolConfig?.identities ? [...poolConfig.identities] : []
    const newIdentity = {
      id,
      credentialRef: ref,
      priority: newKeyPriority || (currentList.length + 1),
      enabled: true,
    }
    const nextPool = {
      strategy: poolConfig?.strategy || 'priority-sticky',
      identities: [...currentList, newIdentity],
    }

    // 0ms instant local update & close modal
    setLocalPool(nextPool)
    setShowAddKeyModal(false)
    setNewKeyId('')
    setNewKeyRef('')
    setNewKeyValue('')
    setNewKeyPriority(1)

    try {
      // 1. Store credential
      const credRes = await api.credentials.set(ref, val)
      if (!credRes.ok) throw new Error(credRes.error.message)

      // 2. Persist pool settings: the draft identity is appended to whatever
      // pool the fresh document carries, and an id already present is the
      // previous attempt's own commit, so a retry never duplicates it.
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        const fresh = poolAt(view)
        if (fresh?.identities?.some(i => i.id === id)) return { ops: [] }
        const identities = [...(fresh?.identities ?? []), newIdentity]
        return {
          ops: [{
            op: 'set',
            path: [...row.entry.settingsPath, 'pool'],
            value: { strategy: fresh?.strategy ?? 'priority-sticky', identities } as unknown as JsonValue,
          }],
        }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))

      onSaved()
      void fetchPoolStatus()
    } catch (err) {
      setLocalPool(prev)
      alert(t('addIdentityFailedAlert', { message: messageOf(err) }))
    } finally {
      setBusy(false)
    }
  }

  const handleConvertToPool = async () => {
    if (!row.apiKeyEnv) {
      // No key configured yet, just open add key modal
      setShowAddKeyModal(true)
      return
    }
    const initialIdentity = {
      id: 'primary',
      credentialRef: row.apiKeyEnv,
      priority: 1,
      enabled: true,
    }
    const nextPool = {
      strategy: 'priority-sticky',
      identities: [initialIdentity],
    }

    // 0ms instant switch
    setLocalPool(nextPool)

    try {
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        // A pool another writer already created is the committed form of this
        // draft: the conversion is idempotent and never restamps the pool.
        const pool = poolAt(view)
        if (pool !== undefined && (pool.identities?.length ?? 0) > 0) return { ops: [] }
        return {
          ops: [{
            op: 'set',
            path: [...row.entry.settingsPath, 'pool'],
            value: nextPool as unknown as JsonValue,
          }],
        }
      })
      if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
      onSaved()
      void fetchPoolStatus()
    } catch (err) {
      setLocalPool(undefined)
      alert(t('convertToPoolFailedAlert', { message: messageOf(err) }))
    }
  }

  const isConfigured = keyState?.configured === true
  // Dashboard links for a non-heavy provider that declares one; the heavy card
  // (below) renders the heavy manifest's own detected/local dashboards.
  const heavyProvider = resolveHeavyManifest(providerId)
  const nonHeavyDashboards = heavyProvider === undefined ? providerDashboardUrls(providerId) : []

  return (
    <div className={styles['detailPanel']}>
      {/* Detail Header */}
      <div className={styles['detailHeader']}>
        <div className={styles['detailIdentity']}>
          <div className={styles['detailAvatar']}>
            <IconServer size={18} />
          </div>
          <div>
            <div className={styles['detailTitleRow']}>
              <h2 className={styles['detailTitle']}>{displayName}</h2>
              <span className={styles['routeSlugBadge']}>{providerId}</span>
              {isDeclared && <span className={styles['customBadge']}>{t('customTag')}</span>}
            </div>
            <p className={styles['detailSub']}>
              <span className={styles['protocolTag']}>{protocol}</span> • <span className={styles['countTag']}>{t('providerModelsCount', { count: modelsList.length })}</span>
            </p>
            {nonHeavyDashboards.length > 0 && (
              <p className={styles['detailSub']}>
                {nonHeavyDashboards.map(url => (
                  <a key={url} className={styles['presetMetaItem']} href={url} target="_blank" rel="noreferrer">
                    {t('heavyDashboard')} ↗
                  </a>
                ))}
              </p>
            )}
          </div>
        </div>

        <div className={styles['detailActions']}>
          {row.removable && (
            <Button
              variant="outline"
              className={styles['deleteBtn']}
              onClick={onDelete}
              disabled={readOnly || busy}
            >
              <IconTrash size={12} />
              {t('remove')}
            </Button>
          )}
        </div>
      </div>

      {/* Heavy provider panel: manifest quirks, dashboard link, health probe.
          It renders only for the three manifest-backed routes. */}
      <HeavyProviderCard
        providerId={providerId}
        t={t}
        modelIds={modelIdList}
        {...heavyProvider === undefined ? {} : { onAutoPopulate: autoPopulate }}
      />

      {/* Key Pool & Identities Card */}
      {poolConfig && poolConfig.identities && poolConfig.identities.length > 0 ? (
        <div className={styles['settingsCard']}>
          <div className={styles['cardHead']}>
            <div className={styles['cardTitleRow']}>
              <IconLayers size={14} />
              <h3 className={styles['cardTitle']}>{t('poolKeysTitle')}</h3>
              <span className={styles['modelCountBadge']}>{poolConfig.identities.length}</span>
            </div>

            <div className={styles['poolHeaderActions']}>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={poolConfig.strategy ?? 'priority-sticky'}
                onChange={(e) => { void handleStrategyChange(e.target.value) }}
                disabled={readOnly || busy}
                title={t('poolStrategyTitle')}
              >
                <option value="priority-sticky">{t('poolStrategyPriority')}</option>
                <option value="balanced">{t('poolStrategyBalanced')}</option>
              </select>
              <button
                type="button"
                className={styles['iconMiniBtn']}
                onClick={() => void fetchPoolStatus()}
                disabled={isPoolLoading}
                title={t('poolRefresh')}
              >
                <IconRefresh size={13} />
              </button>
              <button
                type="button"
                className={styles['addKeyIconBtn']}
                onClick={() => setShowAddKeyModal(true)}
                disabled={readOnly || busy}
                title={t('poolAdd')}
                aria-label={t('poolAdd')}
              >
                <IconKey size={13} />
                <IconPlus size={9} />
              </button>
            </div>
          </div>

          <div className={styles['cardBody']}>
            <div className={styles['identitiesList']}>
              {poolConfig.identities.map((identity, idx) => {
                const status = poolStatusList.find(s => s.id === identity.id)
                const now = Date.now()
                const isCooling = Boolean(status?.cooldownUntil && status.cooldownUntil > now)
                const isError = Boolean(status?.lastStatus && (status.lastStatus === 401 || status.lastStatus === 403))
                const isDisabled = identity.enabled === false
                const cooldownSeconds = isCooling && status?.cooldownUntil ? Math.ceil((status.cooldownUntil - now) / 1000) : 0
                const testResult = identityTestResults[identity.id]

                return (
                  <div
                    key={identity.id}
                    className={`${styles['identityRow']} ${isDisabled ? styles['identityRowDisabled'] : ''} ${isCooling ? styles['identityRowCooling'] : ''} ${isError ? styles['identityRowError'] : ''}`}
                  >
                    <div className={styles['identityLeft']}>
                      <span className={styles['priorityBadge']} title={t('poolPriorityTitle', { n: idx + 1 })}>
                        {t('poolPriorityBadge', { n: idx + 1 })}
                      </span>

                      <div className={styles['identityInfo']}>
                        <div className={styles['identityNameRow']}>
                          <span className={styles['identityName']}>{identity.id}</span>
                          <span className={styles['identityRef']}>{identity.credentialRef}</span>
                        </div>

                        <div className={styles['identityStatusRow']}>
                          {isDisabled ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusDisabled']}`}>
                              <span className={`${styles['statusDot']} ${styles['dotIdle']}`} />
                              {t('poolOff')}
                            </span>
                          ) : isCooling ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusCooling']}`} title={t('poolCoolingDown')}>
                              <span className={`${styles['statusDot']} ${styles['dotCooling']}`} />
                              {cooldownSeconds > 60 ? t('poolCooldownMinutes', { minutes: Math.ceil(cooldownSeconds / 60) }) : t('poolCooldownSeconds', { seconds: cooldownSeconds })}
                            </span>
                          ) : isError ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusError']}`} title={t('poolAuthFailed')}>
                              <span className={`${styles['statusDot']} ${styles['dotError']}`} />
                              {t('poolAuth')}
                            </span>
                          ) : (
                            <span className={`${styles['identityStatusPill']} ${styles['statusReady']}`}>
                              <span className={`${styles['statusDot']} ${styles['dotReady']}`} />
                              {t('poolReady')}
                            </span>
                          )}

                          {status?.quota?.remainingFraction !== undefined && status.quota.remainingFraction !== null && (
                            <div className={styles['quotaMiniWrap']} title={t('poolQuotaRemaining', { percent: Math.round(status.quota.remainingFraction * 100) })}>
                              <div className={styles['quotaMiniBar']}>
                                <div
                                  className={styles['quotaMiniBarFill']}
                                  style={{ width: `${Math.round(status.quota.remainingFraction * 100)}%` }}
                                />
                              </div>
                              <span>{Math.round(status.quota.remainingFraction * 100)}%</span>
                            </div>
                          )}

                          {testResult && (
                            <span style={{ fontSize: '10px', color: testResult.state === 'success' ? '#34d399' : testResult.state === 'error' ? '#f87171' : 'inherit' }}>
                              {testResult.state === 'testing' ? t('poolTesting') : testResult.message}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className={styles['identityActions']}>
                      {/* Move Up */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleMoveIdentity(idx, -1)}
                        disabled={idx === 0 || readOnly || busy}
                        title={t('poolMoveUp')}
                      >
                        <IconArrowUp size={12} />
                      </button>

                      {/* Move Down */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleMoveIdentity(idx, 1)}
                        disabled={idx === (poolConfig?.identities?.length ?? 1) - 1 || readOnly || busy}
                        title={t('poolMoveDown')}
                      >
                        <IconArrowDown size={12} />
                      </button>

                      {/* Reset Cooldown */}
                      {isCooling && (
                        <button
                          type="button"
                          className={styles['iconMiniBtn']}
                          onClick={() => handleResetCooldown(identity.id)}
                          title={t('poolReset')}
                        >
                          <IconRefresh size={12} />
                        </button>
                      )}

                      {/* Test Individual Key */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleTestIdentity(identity.id, identity.credentialRef)}
                        disabled={testResult?.state === 'testing' || readOnly || identityTestUnavailable !== undefined}
                        title={identityTestUnavailable?.message ?? t('poolTest')}
                      >
                        <IconBolt size={12} />
                      </button>

                      {/* Enable/Disable Toggle */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleToggleIdentityEnabled(identity.id)}
                        disabled={readOnly || busy}
                        title={isDisabled ? t('poolEnable') : t('poolDisable')}
                      >
                        {isDisabled ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                      </button>

                      {/* Delete */}
                      <button
                        type="button"
                        className={`${styles['iconMiniBtn']} ${styles['deleteIdentityBtn']}`}
                        onClick={() => handleDeleteIdentity(identity.id)}
                        disabled={readOnly || busy}
                        title={t('poolDelete')}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            {identityTestUnavailable && (
              <p style={{ margin: '8px 0 0', fontSize: '11px', opacity: 0.75 }}>{identityTestUnavailable.message}</p>
            )}
          </div>
        </div>
      ) : (
        /* Single Key Authentication Card */
        <div className={styles['settingsCard']}>
          <div className={styles['cardHead']}>
            <div className={styles['cardTitleRow']}>
              <IconKey size={14} />
              <h3 className={styles['cardTitle']}>{t('apiKeyCardTitle')}</h3>
            </div>
            <div className={styles['poolHeaderActions']}>
              <span
                className={`${styles['statusPill']} ${
                  isConfigured ? styles['statusPillSuccess'] : styles['statusPillWarning']
                }`}
              >
                <span className={`${styles['statusDot']} ${isConfigured ? styles['dotReady'] : styles['dotCooling']}`} />
                {isConfigured ? t('providerConnected') : t('apiKeyNoKey')}
              </span>
              <Button
                variant="outline"
                className={styles['testBtn']}
                onClick={handleConvertToPool}
                disabled={readOnly || busy}
                title={t('poolConvertHint')}
              >
                <IconLayers size={12} />
                {t('poolButtonLabel')}
              </Button>
            </div>
          </div>

          <div className={styles['cardBody']}>
            <div className={styles['keyInputRow']}>
              <div className={styles['passwordInputWrap']}>
                <input
                  className={styles['input']}
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder={isConfigured ? t('keyConfiguredPlaceholder') : t('keyPlaceholder')}
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  disabled={readOnly || busy}
                />
                <button
                  type="button"
                  className={styles['eyeBtn']}
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? t('hideKey') : t('showKey')}
                >
                  {showKey ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>

              <Button
                variant="primary"
                disabled={readOnly || busy || keyInput.trim().length === 0}
                onClick={handleSave}
              >
                <IconCheck size={12} />
                {t('save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Key Modal */}
      {showAddKeyModal && (
        <div className={styles['addKeyModalOverlay']} onClick={() => setShowAddKeyModal(false)}>
          <div className={styles['addKeyModal']} onClick={e => e.stopPropagation()}>
            <div className={styles['addKeyModalTitle']}>
              <IconPlus size={14} />
              {t('poolAddTitle')}
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('poolName')}</label>
              <input
                className={styles['input']}
                type="text"
                placeholder={t('poolNamePlaceholder')}
                value={newKeyId}
                onChange={e => setNewKeyId(e.target.value)}
                autoFocus
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('poolRef')}</label>
              <input
                className={styles['input']}
                type="text"
                placeholder={t('poolRefPlaceholderDynamic', { prefix: providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                value={newKeyRef}
                onChange={e => setNewKeyRef(e.target.value)}
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('poolSecret')}</label>
              <div className={styles['passwordInputWrap']}>
                <input
                  className={styles['input']}
                  type={newKeyShow ? 'text' : 'password'}
                  placeholder={t('poolSecretPlaceholder')}
                  value={newKeyValue}
                  onChange={e => setNewKeyValue(e.target.value)}
                />
                <button
                  type="button"
                  className={styles['eyeBtn']}
                  onClick={() => setNewKeyShow(!newKeyShow)}
                >
                  {newKeyShow ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>
            </div>

            <div className={styles['addKeyModalActions']}>
              <Button
                variant="outline"
                onClick={() => setShowAddKeyModal(false)}
                disabled={busy}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleAddIdentitySubmit}
                disabled={busy || !newKeyId.trim() || !newKeyValue.trim()}
              >
                {busy ? '…' : t('poolSave')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Connection Details Card */}
      <div className={styles['settingsCard']}>
        <div className={styles['cardHead']}>
          <div className={styles['cardTitleRow']}>
            <IconBolt size={14} />
            <h3 className={styles['cardTitle']}>{t('endpointTitle')}</h3>
          </div>

          <Button
            variant="outline"
            className={styles['testBtn']}
            disabled={busy || testStatus.state === 'testing'}
            onClick={handleTestConnection}
          >
            {testStatus.state === 'testing' ? '…' : t('test')}
          </Button>
        </div>

        <div className={styles['cardBody']}>
          <div className={styles['fieldGrid']}>
            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('baseUrl')}</label>
              <input
                className={styles['input']}
                type="text"
                value={baseURL}
                placeholder={OPENAI_BASE_URL_EXAMPLE}
                onChange={e => setBaseURL(e.target.value)}
                disabled={readOnly || busy}
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('protocolLabel')}</label>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={protocol}
                onChange={e => setProtocol(e.target.value)}
                disabled={readOnly || busy}
              >
                {protocols.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Test Status Banner */}
          {testStatus.state !== 'idle' && (
            <div
              className={`${styles['testResultBanner']} ${
                testStatus.state === 'success'
                  ? styles['testResultSuccess']
                  : testStatus.state === 'error'
                    ? styles['testResultError']
                    : styles['testResultPending']
              }`}
            >
              {testStatus.state === 'testing' && t('testingLabel')}
              {testStatus.state === 'success' && (
                <span>
                  <span className={`${styles['statusDot']} ${styles['dotReady']}`} /> <strong>{testStatus.latencyMs}{t('unitMs')}</strong> — {testStatus.message}
                </span>
              )}
              {testStatus.state === 'error' && (
                <span>
                  <span className={`${styles['statusDot']} ${styles['dotError']}`} /> <strong>{t('testFailedLabel')}</strong> — {testStatus.message}
                </span>
              )}
            </div>
          )}

          <div className={styles['saveRow']}>
            {saveSuccess && <span className={styles['savedToast']}>{t('savedLabel')}</span>}
            <Button
              variant="outline"
              disabled={readOnly || busy}
              onClick={handleSave}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      </div>

      {/* Available Models Section */}
      <div className={styles['settingsCard']}>
        <div className={styles['modelsHead']}>
          <div className={styles['modelsTitleRow']}>
            <h3 className={styles['cardTitle']}>{t('models')}</h3>
            <span className={styles['modelCountBadge']}>{modelsList.length}</span>
          </div>

          <div className={styles['modelsHeadActions']}>
            <button
              type="button"
              className={styles['iconMiniBtn']}
              onClick={handleRefreshModels}
              disabled={refreshState.isRefreshing || readOnly}
              title={t('refreshCatalogTitle')}
            >
              <IconRefresh size={13} />
            </button>
            <span className={styles['dotSep']}>•</span>
            <button type="button" className={styles['textActionBtn']} onClick={handleShowAll}>
              {t('showAll')}
            </button>
            <span className={styles['dotSep']}>•</span>
            <button type="button" className={styles['textActionBtn']} onClick={handleHideAll}>
              {t('hideAll')}
            </button>
          </div>
        </div>

        {refreshState.message && (
          <div
            style={{
              padding: '6px 10px',
              fontSize: '11px',
              borderRadius: '6px',
              marginBottom: '8px',
              background: refreshState.isError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: refreshState.isError ? '#f87171' : '#34d399',
              border: refreshState.isError ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            {refreshState.message}
          </div>
        )}

        {/* Model Search */}
        <div className={styles['modelSearchWrap']}>
          <IconSearch size={12} />
          <input
            className={styles['searchInput']}
            type="text"
            placeholder={t('providerModelsSearchPlaceholder', { count: modelsList.length })}
            value={modelSearch}
            onChange={e => setModelSearch(e.target.value)}
          />
          {modelSearch && (
            <button
              type="button"
              className={styles['clearSearchBtn']}
              onClick={() => setModelSearch('')}
            >
              ×
            </button>
          )}
        </div>

        {/* Models List / Grid — 0ms enriched (caps/tokens/hidden precomputed) */}
        <div className={styles['modelsGrid']}>
          {enrichedFilteredModels.length === 0 ? (
            <div className={styles['emptyModels']}>
              {modelSearch ? t('noModelsMatching', { query: modelSearch }) : t('noModelsFound')}
            </div>
          ) : (
            enrichedFilteredModels.map(({ model: m, visibility, caps, contextStr, maxTokStr }) => {

              return (
                <div
                  key={m.id}
                  className={`${styles['modelCard']} ${visibility.hidden ? styles['modelCardHidden'] : ''}`}
                >
                  <div className={styles['modelCardMain']}>
                    <div className={styles['modelTitleRow']}>
                      <span className={styles['modelName']}>{m.name || m.id}</span>
                      {m.deprecated === true
                        ? (
                          <span
                            className={styles['modelBadge']}
                            data-model-badge="deprecated"
                            title={t('modelDeprecatedHint')}
                          >
                            {t('modelDeprecatedBadge')}
                          </span>
                        )
                        : null}
                      <span className={styles['modelIdTag']}>{m.id}</span>
                    </div>

                    <div className={styles['modelMetaRow']}>
                      {/* Capacities */}
                      {(contextStr || maxTokStr) && (
                        <span className={styles['capacityBadge']} title={t('capacityTitle')}>
                          {contextStr ? `${contextStr} ${t('unitIn')}` : ''}{contextStr && maxTokStr ? ' • ' : ''}{maxTokStr ? `${maxTokStr} ${t('unitOut')}` : ''}
                        </span>
                      )}

                      {/* Capabilities Icons — a badge whose capability came from
                          the shared id-hint table (or the sync's labeled
                          capabilityHints) carries data-hint and the hint
                          treatment, so a guess never reads as a disclosure. */}
                      <div className={styles['capIconsList']}>
                        {caps.hasTools && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.tools ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.tools ? 'tools' : undefined}
                            title={t('capTools')}
                          >
                            <IconTools size={10} />
                          </span>
                        )}
                        {caps.hasReasoning && (
                          <span
                            className={`${styles['capIcon']} ${styles['capIconReasoning']}${caps.hinted.reasoning ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.reasoning ? 'reasoning' : undefined}
                            title={t('capReasoning')}
                          >
                            <IconBrain size={10} />
                          </span>
                        )}
                        {caps.hasVision && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.vision ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.vision ? 'vision' : undefined}
                            title={t('capVision')}
                          >
                            <IconVision size={10} />
                          </span>
                        )}
                        {caps.hasAudio && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.audio ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.audio ? 'audio' : undefined}
                            title={t('capAudio')}
                          >
                            <IconAudio size={10} />
                          </span>
                        )}
                        {caps.hasVideo && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.video ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.video ? 'video' : undefined}
                            title={t('capVideo')}
                          >
                            <IconVideo size={10} />
                          </span>
                        )}
                        {caps.hasFiles && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.files ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.files ? 'files' : undefined}
                            title={t('capFiles')}
                          >
                            <IconFile size={10} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Eye Toggle: gated/rule-hidden models state the picker's
                      verdict and cannot be toggled from here; a manual pin can. */}
                  <button
                    type="button"
                    className={`${styles['modelEyeBtn']} ${visibility.hidden ? styles['modelEyeBtnHidden'] : ''}`}
                    disabled={visibility.locked}
                    onClick={() => handleToggleHide(m.id)}
                    title={visibility.hidden
                      ? visibility.locked
                        ? visibility.reason === null ? t('hiddenByRule') : t('hiddenInPicker', { reason: visibility.reason })
                        : t('hiddenClickShow')
                      : t('visibleClickHide')}
                    aria-label={visibility.hidden ? t('showModel', { id: m.id }) : t('hideModel', { id: m.id })}
                  >
                    {visibility.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
