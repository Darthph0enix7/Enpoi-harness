import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { LlmPoolIdentityStatus } from '@deepseek-ai/dsh-llm/types'
import { Button, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconEye, IconEyeOff, IconTools, IconBrain, IconVision, IconAudio, IconVideo, IconFile,
  IconKey, IconBolt, IconTrash, IconCheck, IconSearch, IconServer,
  IconPlus, IconRefresh, IconArrowUp, IconArrowDown, IconLayers,
} from './capability-icons.tsx'
import {
  toggleModelVisibility, hideAllModels, showAllModels,
} from './hidden-models.ts'
import {
  CATALOG_DECISIONS_CHANGED_EVENT, modelVisibility, readCatalogDecisions,
} from './model-visibility.ts'
import { deriveKeyRef, messageOf, protocolChoices, type ProviderRow, type ModelsWire } from './store.ts'
import { refreshRouteViaPlugin, type ProviderSyncRefreshView } from './provider-sync-rpc.ts'
import { applyRefreshedModels } from './provider-sync-apply.ts'
import { normalizeReasoningEfforts, withAdoptedReasoningEfforts, type AdoptedReasoningEfforts } from './reasoning-efforts.ts'
import { applyFenced, fencedFailureText } from './fenced-mutate.ts'
import { HeavyProviderCard } from './HeavyProviderCard.tsx'
import { resolveHeavyManifest } from './heavy-manifest-source.ts'
import { providerDashboardUrls } from './provider-templates.ts'
import { OPENAI_BASE_URL_EXAMPLE } from './endpoint-defaults.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelMetadataDraft, ModelMetadataKind } from './model-metadata.ts'
import { buildModelMetadataOps, metadataKindOf, ModelMetadataOpsError } from './model-metadata.ts'
import { ModelMetadataDialog } from './ModelMetadataDialog.tsx'
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
  /**
   * Refresh the page after a write. A committed settings view lets the page
   * fold the authoritative revision instead of waiting for a pushed echo.
   */
  onSaved: (view?: SettingsNamespaceView) => void
}

type ModelItem = {
  id: string
  name?: string
  contextWindow?: number
  maxInputTokens?: number
  maxTokens?: number
  /** An explicit `false` disables reasoning; `{}` states no selectable level. */
  reasoningEfforts?: false | Record<string, unknown>
  reasoning?: boolean | object | null
  input?: string[]
  /**
   * Effective input modalities when the catalog projection provides them.
   * Audio/video/pdf appear only when the exact model opted into a native
   * descriptor; otherwise the pi-ai wire encoding sends text/image only.
   */
  inputModalities?: string[]
  /** Modalities the provider advertises, including disclosure-only tokens. */
  advertisedInputModalities?: string[]
  /**
   * The route's explicit native-file descriptor for this exact model. A
   * configured model row declares one encoder plus the MIME types it admits;
   * a resolved catalog fact may instead carry the encoder map. Either form
   * names the media the adapter genuinely sends natively.
   */
  nativeFileInputs?: {
    /** Declared MIME types the descriptor's encoder carries. */
    mime?: string[]
    /** Resolved MIME-to-encoder map carried by catalog facts. */
    encoders?: Record<string, string>
  }
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  files?: boolean
  /** The listing's own price fields, when the row still carries discovery fields. */
  cost?: unknown
  /** Catalog release date, when the source disclosed one. */
  releaseDate?: string
  /** Request-wide price tiers, when the source disclosed them. */
  costTiers?: readonly { inputTokensAbove?: number; input?: number; output?: number }[]
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
  /** The sync's source stamp (`manual` survives catalog removal). */
  source?: string
  /**
   * Fields the operator explicitly overrode on this row. A field absent here
   * is inherited, so the metadata dialog offers no reset for it.
   */
  manualFields?: string[]
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
  /** An explicit `false` disables reasoning; `{}` states no selectable level. */
  reasoningEfforts?: false | Record<string, unknown>
  supported_parameters?: string[]
  tools?: boolean
  cost?: unknown
  gated?: boolean
  gateReason?: string
  isFree?: boolean
  /** Where the row came from: a live endpoint listing or the installed catalog. */
  source?: 'endpoint' | 'catalog'
  /** Why the installed catalog answered instead of the endpoint. */
  fallbackReason?: string
}

/**
 * The capability fields one discovered row disclosed, as a stored model row
 * carries them. A field the discovery said nothing about stays out, a gate
 * reason rides its gate, and the reasoning ladder adopts through the shared
 * normalization: a disclosed `false` and a valid ladder are preserved while a
 * stated-but-empty ladder is omitted (the settings schema refuses an empty
 * dictionary). The ladder's `declared` flag lets a merge clear a stale
 * configured mapping the endpoint has retracted.
 */
function disclosedCapabilities(discovered: DiscoveredModel): {
  fields: Partial<ModelItem>
  ladder: AdoptedReasoningEfforts
} {
  const ladder = normalizeReasoningEfforts(discovered.reasoningEfforts)
  return {
    ladder,
    fields: {
      ...discovered.reasoning === undefined ? {} : { reasoning: discovered.reasoning },
      ...ladder.value === undefined ? {} : { reasoningEfforts: ladder.value },
      ...discovered.supported_parameters === undefined ? {} : { supported_parameters: discovered.supported_parameters },
      ...discovered.tools === undefined ? {} : { tools: discovered.tools },
      ...discovered.cost === undefined ? {} : { cost: discovered.cost },
      ...discovered.gated === true ? { gated: true } : {},
      ...discovered.gated === true && discovered.gateReason !== undefined ? { gateReason: discovered.gateReason } : {},
      ...discovered.isFree === undefined ? {} : { isFree: discovered.isFree },
    },
  }
}

/**
 * Merge one discovery answer into a route's configured models without
 * deleting any: only values the answer actually disclosed refresh a row, an
 * advertised id the answer names but leaves bare keeps its configured fields,
 * an id the answer omits stays exactly as configured, and an id configuration
 * does not name is appended with only its disclosed fields. The route's
 * `defaultContextWindow` / `defaultMaxTokens` are execution fallbacks, never
 * per-model facts, so the merge never writes them.
 * @param configured - the route's current `models` array.
 * @param discovered - one discovery answer, in endpoint order.
 * @returns the merged list, configured entries first.
 */
export function mergeRefreshedModels(
  configured: readonly ModelItem[],
  discovered: readonly DiscoveredModel[],
): ModelItem[] {
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
    const disclosed = disclosedCapabilities(fresh)
    const refreshed: ModelItem = {
      ...model,
      name: fresh.name !== undefined && fresh.name !== fresh.id ? fresh.name : model.name ?? fresh.id,
      ...fresh.contextWindow === undefined ? {} : { contextWindow: fresh.contextWindow },
      ...fresh.maxTokens === undefined ? {} : { maxTokens: fresh.maxTokens },
      ...model.input === undefined && fresh.inputModalities !== undefined && fresh.inputModalities.length > 0
        ? { input: [...fresh.inputModalities] } : {},
      ...disclosed.fields,
    }
    // A stated ladder that normalizes away is still an answer: drop the stale
    // configured mapping instead of carrying it through the spread above.
    if (disclosed.ladder.declared && disclosed.ladder.value === undefined) delete refreshed.reasoningEfforts
    merged.push(refreshed)
  }
  for (const model of discovered) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    merged.push({
      id: model.id,
      name: model.name !== undefined && model.name !== model.id ? model.name : model.id,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined || model.inputModalities.length === 0
        ? {} : { input: [...model.inputModalities] },
      ...disclosedCapabilities(model).fields,
    })
  }
  return merged
}

/** Narrow one stored JSON node to a record, or undefined for a non-record. */
function recordAt(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Whether one route profile carries any per-model catalog overrides. */
function hasModelOverrides(profile: Record<string, unknown> | undefined): boolean {
  const overrides = profile === undefined ? undefined : recordAt(profile.modelOverrides)
  return overrides !== undefined && Object.keys(overrides).length > 0
}

/** A refresh refusal that must keep its localized message verbatim. */
class CatalogOverrideRefreshRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogOverrideRefreshRefused'
  }
}

/** A metadata save refusal raised by the fresh-document guard. */
class ModelListNotStoredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelListNotStoredError'
  }
}

/** Fields a legacy `source: manual` row froze before `manualFields` existed. */
const LEGACY_MANUAL_DRAFT_FIELDS = [
  'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts',
] as const

/** Whether a stored value round-trips to a non-empty value. */
function hasStoredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  const record = recordAt(value)
  if (record !== undefined) return Object.keys(record).length > 0
  if (typeof value === 'string') return value.length > 0
  return typeof value === 'number' || typeof value === 'boolean'
}

/**
 * The legacy manual-field list for a row written before `manualFields`
 * existed. The helper still seeds these fields, so the dialog must offer the
 * same resets instead of leaving an operator unable to express the intent.
 * @param model - the stored row.
 * @param kind - the row's layout.
 * @returns the stored legacy field names.
 */
function legacyManualFieldsOf(model: ModelItem, kind: ModelMetadataKind): readonly string[] {
  const fields: string[] = []
  for (const field of LEGACY_MANUAL_DRAFT_FIELDS) {
    if (kind === 'deepseek'
      && (field === 'maxInputTokens' || field === 'reasoning' || field === 'reasoningEfforts')) continue
    const storage = field === 'input' ? kind === 'deepseek' ? 'inputModalities' : 'input' : field
    if (hasStoredValue(model[storage])) fields.push(storage)
  }
  return fields
}

/**
 * One installed-catalog discovery row as the panel renders it. The catalog
 * wire names input modalities directly; a stored pi-ai row names them under
 * `input`, so the two vocabularies meet here, before the dialog reads the row.
 * @param model - one discovery row.
 * @returns the panel's model row.
 */
function catalogRowOf(model: LlmDiscoveredModel): ModelItem {
  const row: ModelItem = {
    id: model.id,
    ...model.name === undefined ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.inputModalities === undefined ? {} : { input: [...model.inputModalities] },
    ...model.tools === undefined ? {} : { tools: model.tools },
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...model.reasoningEfforts } },
    ...model.source === undefined ? {} : { source: model.source },
  }
  // A discovery answer from the installed catalog can carry the richer record
  // the catalog analysis retained even though the shared wire type names only
  // the request-facing fields.
  const retained = recordAt(model)
  if (retained?.cost !== undefined) row.cost = retained.cost
  if (typeof retained?.releaseDate === 'string') row.releaseDate = retained.releaseDate
  if (Array.isArray(retained?.costTiers)) {
    row.costTiers = retained.costTiers
      .map(recordAt)
      .filter((tier): tier is Record<string, unknown> => tier !== undefined)
      .map(tier => ({
        ...typeof tier.inputTokensAbove === 'number' ? { inputTokensAbove: tier.inputTokensAbove } : {},
        ...typeof tier.input === 'number' ? { input: tier.input } : {},
        ...typeof tier.output === 'number' ? { output: tier.output } : {},
      }))
  }
  return row
}

/**
 * The fields an operator overrode on one row. The provider sync stamps them
 * on the row; a catalog edit stores the same facts as the `modelOverrides`
 * entry keyed by the model id, so the override fields are that entry's keys.
 * @param model - the effective row.
 * @param profile - the route profile.
 * @param kind - the row's adapter/ownership kind.
 * @returns the explicitly overridden field names.
 */
function manualFieldsOf(
  model: ModelItem,
  profile: Record<string, unknown>,
  kind: ModelMetadataKind,
  modelId: string,
): readonly string[] {
  if (Array.isArray(model.manualFields)) {
    return model.manualFields.filter((field): field is string => typeof field === 'string')
  }
  if (model.source === 'manual') return legacyManualFieldsOf(model, kind)
  if (kind !== 'pi-ai-catalog') return []
  const overrides = recordAt(profile.modelOverrides)
  const entry = overrides === undefined ? undefined : recordAt(overrides[modelId])
  return entry === undefined ? [] : Object.keys(entry)
}

/**
 * Localize a metadata plan refusal. The dialog already validates the draft, so
 * a refusal here is a race the fresh document reports: the row vanished, an id
 * collision appeared, or a catalog override tried to move its dictionary key.
 * @param t - the panel translate.
 * @param error - the thrown planning error.
 * @returns the text the dialog shows and keeps open.
 */
function modelMetadataFailureText(
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
  error: unknown,
): string {
  if (error instanceof ModelMetadataOpsError) {
    switch (error.code) {
      case 'invalid-draft': return t('metadataOpsInvalidDraft')
      case 'model-not-found': return t('metadataOpsModelNotFound')
      case 'duplicate-id': return t('metadataOpsDuplicateId')
      case 'id-change-not-allowed': return t('metadataOpsIdChange')
    }
  }
  return t('metadataSaveFailed', { message: messageOf(error) })
}

/**
 * Merge the route's per-model catalog overrides onto one installed row so the
 * panel and its dialog show what the adapter would serve, not the raw catalog
 * defaults an override replaced.
 * @param model - one installed-catalog row.
 * @param profile - the route profile carrying `modelOverrides`.
 * @returns the effective row, with its catalog id unchanged.
 */
function catalogRowWithOverrides(model: ModelItem, profile: Record<string, unknown>): ModelItem {
  const overrides = recordAt(profile.modelOverrides)
  const entry = overrides === undefined ? undefined : recordAt(overrides[model.id])
  if (entry === undefined) return model
  const next: ModelItem = { ...model }
  if (typeof entry.name === 'string') next.name = entry.name
  if (typeof entry.contextWindow === 'number') next.contextWindow = entry.contextWindow
  if (typeof entry.maxInputTokens === 'number') next.maxInputTokens = entry.maxInputTokens
  if (typeof entry.maxTokens === 'number') next.maxTokens = entry.maxTokens
  if (Array.isArray(entry.input)) {
    next.input = entry.input.filter((value): value is string => typeof value === 'string')
  }
  if (typeof entry.tools === 'boolean') next.tools = entry.tools
  if (typeof entry.reasoning === 'boolean') next.reasoning = entry.reasoning
  if (entry.reasoningEfforts === false) next.reasoningEfforts = false
  else {
    const efforts = recordAt(entry.reasoningEfforts)
    if (efforts !== undefined) next.reasoningEfforts = efforts
  }
  if (entry.cost !== undefined) next.cost = entry.cost
  if (typeof entry.releaseDate === 'string') next.releaseDate = entry.releaseDate
  if (Array.isArray(entry.costTiers)) {
    next.costTiers = entry.costTiers
      .map(recordAt)
      .filter((tier): tier is Record<string, unknown> => tier !== undefined)
      .map(tier => ({
        ...typeof tier.inputTokensAbove === 'number' ? { inputTokensAbove: tier.inputTokensAbove } : {},
        ...typeof tier.input === 'number' ? { input: tier.input } : {},
        ...typeof tier.output === 'number' ? { output: tier.output } : {},
      }))
  }
  return next
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

/**
 * The warning text for a discovery answer the installed catalog answered. A
 * 401 on a catalog-backed route must not read as a successful live probe.
 * @param models - one discovery answer.
 * @param t - the panel translate.
 * @returns the warning text, or undefined for a live endpoint answer.
 */
function catalogFallbackNotice(
  models: readonly DiscoveredModel[],
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string | undefined {
  const fallback = models.find(model => model.source === 'catalog')
  if (fallback === undefined) return undefined
  return fallback.fallbackReason === undefined || fallback.fallbackReason.trim() === ''
    ? t('discoveryCatalogFallbackNoReason')
    : t('discoveryCatalogFallback', { reason: fallback.fallbackReason })
}

/** The capability badges one row can state, and where each rests. */
interface CapabilityView {
  hasReasoning: boolean
  hasVision: boolean
  hasAudio: boolean
  hasVideo: boolean
  hasFiles: boolean
  hasTools: boolean
  /** Badges backed only by a stored hint claim, never a disclosure. */
  hinted: {
    reasoning: boolean
    vision: boolean
    audio: boolean
    video: boolean
    files: boolean
  }
  /** Advertised audio/video/pdf tokens the adapter does not send natively. */
  declaredOnly: string[]
}

/** Modality tokens no native pi-ai request encodes; they are disclosure-side. */
const DISCLOSURE_ONLY_MODALITIES: ReadonlySet<string> = new Set(['audio', 'video', 'pdf'])

/** Disclosure-only modality tokens in display order. */
const DISCLOSURE_ONLY_ORDER = ['pdf', 'audio', 'video'] as const

/**
 * Disclosure-only modality kinds a stored model's native-file descriptor
 * actually encodes. The configured row declares `mime` types; a resolved
 * catalog fact may carry the `encoders` map instead.
 * @param model - one stored model row.
 * @returns kinds named by the descriptor; empty when it encodes none.
 */
function nativeInputKinds(model: ModelItem): ReadonlySet<string> {
  const kinds = new Set<string>()
  const descriptor = model.nativeFileInputs
  const mimes = [
    ...descriptor?.mime ?? [],
    ...Object.keys(descriptor?.encoders ?? {}),
  ]
  for (const mime of mimes) {
    if (mime === 'application/pdf') kinds.add('pdf')
    else if (mime.startsWith('audio/')) kinds.add('audio')
    else if (mime.startsWith('video/')) kinds.add('video')
  }
  return kinds
}

/** One stored row's stated input tokens, most authoritative source first. */
function statedInputs(model: ModelItem): string[] {
  if (Array.isArray(model.inputModalities)) return model.inputModalities
  if (Array.isArray(model.input)) return model.input
  return Array.isArray(model.architecture?.input_modalities) ? model.architecture.input_modalities : []
}

/**
 * Detect the capability badges one model row renders.
 *
 * Only disclosed data supports a badge: `inputModalities` (or the stored
 * `input` / architecture fallback) is authoritative for input, an explicit
 * `reasoning`/`tools` flag or `supported_parameters` entry states those
 * capabilities, and an advertised audio/video/pdf token reads as native
 * support only when the model's own `nativeFileInputs` descriptor carries an
 * encoder for that kind. A stored `capabilityHints` claim may still render a
 * badge, but only under the unverified treatment — the panel never infers
 * capabilities from an id.
 */
function detectCapabilities(model: ModelItem): CapabilityView {
  const stated = statedInputs(model)
  // The effective set excludes disclosure-only tokens unless the model's own
  // native-file descriptor admits that kind: a stored `input: ['text','audio']`
  // declares audio upstream, and only an encoder makes it native support.
  const native = nativeInputKinds(model)
  const effective = stated.filter(token => !DISCLOSURE_ONLY_MODALITIES.has(token) || native.has(token))
  for (const kind of DISCLOSURE_ONLY_ORDER) {
    if (native.has(kind) && !effective.includes(kind)) effective.push(kind)
  }
  const advertised = new Set<string>([
    ...model.advertisedInputModalities ?? [],
    ...stated.filter(token => DISCLOSURE_ONLY_MODALITIES.has(token)),
  ])
  if (model.audio === true) advertised.add('audio')
  if (model.video === true) advertised.add('video')
  if (model.files === true) advertised.add('pdf')
  const declaredOnly = [...advertised]
    .filter(token => DISCLOSURE_ONLY_MODALITIES.has(token) && !effective.includes(token))

  const stored = model.capabilityHints
  const hintInputs: readonly string[] = stored?.input ?? []

  // 1. REASONING / THINKING — an explicit boolean/object/efforts/parameters
  // fact wins. `false` beside a stored hint set is the sync's schema floor,
  // not a disclosure of absence, so it yields to the hint; without stored
  // hints it is a disclosure and blocks the heuristic.
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
  const hasReasoning = disclosedReasoningFact ?? stored?.reasoning === true
  const reasoningHinted = disclosedReasoningFact === undefined && stored?.reasoning === true

  // 2. VISION / IMAGE INPUT — effective image input only.
  const visionFact = model.vision ?? (effective.includes('image') || effective.includes('vision') ? true : undefined)
  const hasVision = visionFact ?? hintInputs.includes('image')
  const visionHinted = visionFact === undefined && hintInputs.includes('image')

  // 3. AUDIO INPUT — a native audio badge requires an effective audio token;
  // an explicit audio flag or an advertised-only token is rendered by
  // `declaredOnly`, never as native support.
  const hasAudio = effective.includes('audio')
  const audioHinted = !hasAudio && !declaredOnly.includes('audio') && hintInputs.includes('audio')

  // 4. VIDEO INPUT — same native/disclosure split as audio.
  const hasVideo = effective.includes('video')
  const videoHinted = !hasVideo && !declaredOnly.includes('video') && hintInputs.includes('video')

  // 5. TOOL CALLING — only a disclosed flag or parameter supports the badge;
  // there is no default-on state.
  const toolsFact = model.tools ?? (model.supported_parameters?.includes('tools') ? true : undefined)
  const hasTools = toolsFact === true

  // 6. DOCUMENTS & FILES — native file/document tokens only; advertised pdf
  // is disclosure-side.
  const hasFiles = effective.includes('file') || effective.includes('document') || effective.includes('pdf')
  const filesHinted = !hasFiles && !declaredOnly.includes('pdf') && hintInputs.includes('pdf')

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
    },
    declaredOnly,
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

/** 0ms shown-map reader: explicit eye-toggle "shown" pins for this panel. */
function readShownMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem('dsh_shown_models_v1')
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

  // The resolved effective profile: schema defaults and the composition base
  // below the user layer. The models list and its metadata read this so a
  // route that configures nothing still exposes the adapter's catalog rows.
  const effectiveProfile = useMemo(() => {
    return (schema.getPath(namespace.value, row.entry.settingsPath) ?? {}) as Record<string, unknown>
  }, [namespace.value, row.entry.settingsPath, schema])
  const userProfile = useMemo(() => {
    return recordAt(schema.getPath(namespace.user, row.entry.settingsPath))
  }, [namespace.user, row.entry.settingsPath, schema])

  // The fenced write plans re-read the live document per attempt: these read
  // one fresh described view with the same precedence as the render's own
  // snapshot, so each retry re-applies the operator's draft onto current data.
  const profileAt = useCallback((view: SettingsNamespaceView | undefined): Record<string, unknown> => {
    return (schema.getPath(view?.user, row.entry.settingsPath) ??
      schema.getPath(view?.value, row.entry.settingsPath) ??
      {}) as Record<string, unknown>
  }, [row.entry.settingsPath, schema])
  /** The effective profile out of one fresh described view, for a row lookup. */
  const effectiveProfileAt = useCallback((view: SettingsNamespaceView | undefined): Record<string, unknown> => {
    return (schema.getPath(view?.value, row.entry.settingsPath) ?? {}) as Record<string, unknown>
  }, [row.entry.settingsPath, schema])
  /** The canonical pool out of one fresh profile, matching the serverPool read. */
  const poolAt = useCallback((view: SettingsNamespaceView | undefined): PoolShape => {
    const p = profileAt(view)['pool'] as PoolShape
    return p && Array.isArray(p.identities) ? p : undefined
  }, [profileAt])
  /**
   * The models list out of one fresh effective profile. Reading `value`
   * rather than the raw user overlay keeps base-inherited rows in a refresh
   * merge instead of treating an absent user `models` key as an empty list.
   */
  const modelsAt = useCallback((view: SettingsNamespaceView | undefined): ModelItem[] => {
    const list = effectiveProfileAt(view)['models']
    return Array.isArray(list) ? list as ModelItem[] : []
  }, [effectiveProfileAt])

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
  const shownMap = useMemo(() => readShownMap(), [prefsVersion])
  const shownSets = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [k, v] of Object.entries(shownMap)) if (Array.isArray(v)) m.set(k, new Set(v))
    return m
  }, [shownMap])
  const shownSet = useMemo(() => shownSets.get(providerId) ?? new Set<string>(), [shownSets, providerId])
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
    setEditingModel(undefined)
    setCatalogState(undefined)
    setCatalogError(undefined)
    setCatalogBusy(false)
    catalogRequest.current += 1
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
    const list = effectiveProfile.models
    if (Array.isArray(list) && list.length > 0) {
      return list as ModelItem[]
    }
    return []
  }, [effectiveProfile.models])

  // The adapter family and ownership form decide what an edit may write. An
  // unrecognized provider gets no edit action rather than a guessed write.
  const metadataKind = useMemo(
    () => metadataKindOf(namespace.ns, effectiveProfile),
    [namespace.ns, effectiveProfile],
  )
  // A model array inherited from the composition base or adapter defaults has
  // no writable leaf to address; materializing the whole list belongs to the
  // catalog editor, so these rows stay read-only rather than fabricating a
  // save into an array the user layer does not own.
  const modelsMaterialized = Array.isArray(userProfile?.models) && userProfile.models.length > 0
  const inheritedModelsBlocked = (metadataKind === 'deepseek' || metadataKind === 'pi-ai-models')
    && !modelsMaterialized

  // Installed-catalog rows are read only on demand: a route that configures no
  // models still serves the adapter's catalog, and an operator edits that
  // catalog one model at a time. Reading it is a discovery call, not a write,
  // so it stays behind an explicit action instead of firing on every card
  // render (a heavy route's automatic populate owns its own pass).
  const [catalogState, setCatalogState] = useState<{
    provider: string
    models: readonly ModelItem[]
  } | undefined>(undefined)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined)
  const catalogRequest = useRef(0)
  const [editingModel, setEditingModel] = useState<{
    modelId: string
    kind: ModelMetadataKind
    /** Immutable row the dialog opens with; never the retry's fresh profile. */
    baseline: Record<string, unknown>
    /** Untouched installed-catalog row behind a per-model override. */
    inherited?: Record<string, unknown>
    manualFields: readonly string[]
  } | undefined>(undefined)

  const catalogShown = modelsList.length === 0 && catalogState?.provider === providerId
  const catalogModels = useMemo(() => {
    if (catalogState?.provider !== providerId) return []
    return catalogState.models.map(model => catalogRowWithOverrides(model, effectiveProfile))
  }, [catalogState, providerId, effectiveProfile])
  const displayedModels = modelsList.length > 0 ? modelsList : catalogShown ? catalogModels : []
  const canLoadCatalog = modelsList.length === 0
    && modelSearch.trim() === ''
    && metadataKind !== undefined
    && metadataKind !== 'deepseek'
    && !catalogShown

  const loadCatalogModels = async (): Promise<void> => {
    if (catalogBusy) return
    const request = catalogRequest.current + 1
    catalogRequest.current = request
    setCatalogBusy(true)
    setCatalogError(undefined)
    try {
      const answer = await api.llm.discoverModels(namespace.ns, { provider: providerId })
      if (catalogRequest.current !== request) return
      if (answer.ok) {
        setCatalogState({ provider: providerId, models: answer.value.map(catalogRowOf) })
      } else {
        setCatalogError(answer.error.message)
      }
    } catch (error) {
      if (catalogRequest.current === request) setCatalogError(messageOf(error))
    } finally {
      if (catalogRequest.current === request) setCatalogBusy(false)
    }
  }

  // The route's model ids, stable across unrelated renders: the heavy card's
  // automatic-population decision watches this list.
  const modelIdList = useMemo(() => modelsList.map(model => model.id), [modelsList])

  // Filtered models
  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase().trim()
    if (!q) return displayedModels
    return displayedModels.filter((m) => {
      const name = (m.name || '').toLowerCase()
      const id = (m.id || '').toLowerCase()
      return name.includes(q) || id.includes(q)
    })
  }, [modelSearch, displayedModels])

  // 0ms: enrich once per filtered list; caps cached via WeakMap so 500× string scans O(1) on re-switch
  const enrichedFilteredModels = useMemo(() => {
    return filteredModels.map(m => ({
      model: m,
      visibility: modelVisibility(m, hiddenSet, catalogDecisions.get(`${providerId}/${m.id}`), shownSet),
      caps: getCapsCached(m),
      contextStr: formatTokens(m.contextWindow ?? m.maxInputTokens),
      maxTokStr: formatTokens(m.maxTokens),
    }))
  }, [filteredModels, hiddenSet, shownSet, catalogDecisions, providerId])

  // Toggle model visibility from the state the eye renders: a model the picker
  // hides via a rule or gate is shown by pinning it, not by adding it to the
  // hidden list; 0ms optimistic write + debounced serialized persistence.
  const handleToggleHide = (modelId: string, currentlyHidden: boolean) => {
    toggleModelVisibility(providerId, modelId, currentlyHidden)
    setPrefsVersion(v => v + 1)
  }

  // Bulk hide/show
  const handleHideAll = () => {
    const allIds = displayedModels.map(m => m.id)
    hideAllModels(providerId, allIds)
    setPrefsVersion(v => v + 1)
  }

  const handleShowAll = () => {
    showAllModels(providerId, displayedModels.map(m => m.id))
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
        const discovered = (res.value as DiscoveredModel[] | undefined) ?? []
        const count = discovered.length
        const fallback = catalogFallbackNotice(discovered, t)
        setTestStatus({
          state: 'success',
          message: fallback === undefined
            ? t('connectedModels', { count })
            : `${t('connectedModels', { count })} — ${fallback}`,
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
    // The host pipeline and the fallback both persist a `models` array, which
    // cannot coexist with `modelOverrides`. Refuse before any network call so
    // a route that already has overrides never loses them to a refresh.
    if (hasModelOverrides(effectiveProfile)) {
      if (options.silent !== true) {
        setRefreshState({
          isRefreshing: false,
          message: t('refreshBlockedModelOverrides'),
          isError: true,
        })
        scheduleRefreshClear(6000)
      }
      return false
    }
    catalogRefreshInFlight.current = true
    if (options.silent !== true) setRefreshState({ isRefreshing: true })
    try {
      // The removal-aware host pipeline is preferred even for the automatic
      // (silent) pass: it owns membership, protections, and source tags. Only
      // an unavailable/refused RPC falls back to plain discovery, which then
      // merges disclosed values only.
      const hosted = await refreshRouteViaPlugin(providerId)
      if (hosted.ok) {
        const report = hosted.value
        let count = 0
        const outcome = await applyFenced(api, namespace.ns, (view) => {
          // A concurrent writer may add an override while the host call is in
          // flight; re-check the fresh document before planning any array write.
          if (hasModelOverrides(effectiveProfileAt(view))) {
            throw new CatalogOverrideRefreshRefused(t('refreshBlockedModelOverrides'))
          }
          // The host answer is the canonical membership, but a degraded or
          // older sync may still hand back an empty ladder the settings schema
          // refuses; the shared normalization keeps the persisted route valid.
          const merged = applyRefreshedModels(modelsAt(view), report.models.map(withAdoptedReasoningEfforts), report.removed)
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
          // The fallback planner carries the same fresh-document refusal: a
          // concurrent override must survive even when the host RPC is absent.
          if (hasModelOverrides(effectiveProfileAt(view))) {
            throw new CatalogOverrideRefreshRefused(t('refreshBlockedModelOverrides'))
          }
          // Merge, never replace: a Refresh may add and update models, but
          // deleting one is the operator's decision, not a listing's. Only
          // disclosed fields land; route defaults stay virtual.
          const merged = mergeRefreshedModels(modelsAt(view), discovered)
          count = merged.length
          return {
            ops: [{ op: 'set', path: [...row.entry.settingsPath, 'models'], value: merged as unknown as JsonValue }],
          }
        })
        if (outcome.error !== null) throw new Error(fencedFailureText(t, outcome.error))
        const fallback = catalogFallbackNotice(discovered, t)
        setRefreshState({
          isRefreshing: false,
          message: fallback === undefined ? t('refreshedModels', { count }) : `${t('refreshedModels', { count })} — ${fallback}`,
          isError: false,
        })
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
          message: err instanceof CatalogOverrideRefreshRefused
            ? err.message
            : t('refreshFailed', { message: messageOf(err) }),
          isError: true,
        })
        scheduleRefreshClear(err instanceof CatalogOverrideRefreshRefused ? 6000 : 5000)
      }
      return false
    } finally {
      catalogRefreshInFlight.current = false
    }
  }, [
    api, baseURL, effectiveProfile, effectiveProfileAt, keyInput, modelsAt, namespace.ns,
    onSaved, providerId, protocol, readOnly, row.entry.settingsPath, scheduleRefreshClear, t,
  ])

  const handleRefreshModels = (): void => { void runCatalogRefresh() }

  // The heavy card's automatic pass: silent on failure, success still reports
  // the count and reloads the settings view.
  const autoPopulate = useCallback(() => runCatalogRefresh({ silent: true }), [runCatalogRefresh])

  // One row's write form. A catalog row keeps its installed id and writes a
  // per-model override; a materialized row may change its id, which adds a
  // separate entry instead of renaming the one sessions already reference.
  const rowKindOf = useCallback((fromCatalog: boolean): ModelMetadataKind | undefined => {
    if (metadataKind === undefined) return undefined
    if (metadataKind === 'deepseek' || metadataKind === 'pi-ai-models') {
      return modelsMaterialized ? metadataKind : undefined
    }
    return fromCatalog ? 'pi-ai-catalog' : 'pi-ai-models'
  }, [metadataKind, modelsMaterialized])

  /** Whether the fresh document still stores a model array this save may index. */
  const hasStoredModelList = useCallback((view: SettingsNamespaceView | undefined): boolean => {
    const profile = recordAt(schema.getPath(view?.user, row.entry.settingsPath))
    return Array.isArray(profile?.models) && profile.models.length > 0
  }, [row.entry.settingsPath, schema])

  /** Snapshot one row at open time so a settings echo cannot move its baseline. */
  const openModelMetadata = (model: ModelItem, kind: ModelMetadataKind): void => {
    const fromCatalog = kind === 'pi-ai-catalog'
    const inherited = fromCatalog
      ? catalogState?.models.find(candidate => candidate.id === model.id)
      : undefined
    const override = fromCatalog
      ? recordAt(recordAt(effectiveProfile.modelOverrides)?.[model.id])
      : undefined
    const baseline: Record<string, unknown> = fromCatalog
      ? { id: model.id, ...(override ?? {}) }
      : { ...model }
    const manualFields = fromCatalog
      ? override === undefined ? [] : Object.keys(override)
      : manualFieldsOf(model, effectiveProfile, kind, model.id)
    setEditingModel({
      modelId: model.id,
      kind,
      baseline,
      ...inherited === undefined ? {} : { inherited: { ...inherited } },
      manualFields,
    })
  }

  /**
   * Persist one metadata draft with revision fencing. The fresh document is
   * re-read on every attempt and the helper locates the original row by id,
   * so a concurrent catalog/model refresh is never replayed from this render.
   */
  const saveModelMetadata = useCallback(async (
    modelId: string,
    kind: ModelMetadataKind,
    draft: ModelMetadataDraft,
    baselineDraft: ModelMetadataDraft,
    resetFields: readonly string[],
  ): Promise<string | undefined> => {
    try {
      const outcome = await applyFenced(api, namespace.ns, (view) => {
        if ((kind === 'pi-ai-models' || kind === 'deepseek') && !hasStoredModelList(view)) {
          throw new ModelListNotStoredError(t(kind === 'deepseek'
            ? 'metadataDeepseekUnavailable'
            : 'metadataPiAiInheritedModelsHint'))
        }
        const freshProfile = effectiveProfileAt(view)
        if (kind === 'pi-ai-catalog'
          && ((Array.isArray(freshProfile.models) && freshProfile.models.length > 0)
            || freshProfile.catalogAuthority === 'endpoint')) {
          throw new ModelListNotStoredError(t('metadataCatalogChanged'))
        }
        return {
          ops: buildModelMetadataOps({
            kind,
            providerId,
            modelId,
            profile: freshProfile,
            draft,
            baselineDraft,
            resetFields,
          }),
        }
      })
      if (outcome.error !== null) return fencedFailureText(t, outcome.error)
      onSaved(outcome.view)
      return undefined
    } catch (error) {
      if (error instanceof ModelListNotStoredError) return error.message
      return modelMetadataFailureText(t, error)
    }
  }, [api, effectiveProfileAt, hasStoredModelList, namespace.ns, onSaved, providerId, t])

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
  const poolIdentityCount = poolConfig?.identities?.length ?? 0
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
                        disabled={idx === poolIdentityCount - 1 || readOnly || busy}
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
            <span className={styles['modelCountBadge']}>{displayedModels.length}</span>
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
            placeholder={t('providerModelsSearchPlaceholder', { count: displayedModels.length })}
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

        {/* An installed catalog is edited through per-model overrides, so the
            route keeps serving every other catalog entry and no explicit
            `models` array is materialized behind the operator. */}
        {catalogShown && (
          <p className={styles['metadataNotice']}>{t('metadataCatalogNotice')}</p>
        )}
        {inheritedModelsBlocked && (
          <p className={styles['metadataNotice']}>
            {metadataKind === 'deepseek'
              ? t('metadataDeepseekUnavailable')
              : t('metadataPiAiInheritedModelsHint')}
          </p>
        )}

        {/* Models List / Grid — 0ms enriched (caps/tokens/hidden precomputed) */}
        <div className={styles['modelsGrid']}>
          {enrichedFilteredModels.length === 0 ? (
            <div className={styles['emptyModels']}>
              <p className={styles['metadataEmptyText']}>
                {modelSearch
                  ? t('noModelsMatching', { query: modelSearch })
                  : catalogShown ? t('metadataCatalogEmpty') : t('noModelsFound')}
              </p>
              {canLoadCatalog && (
                <button
                  type="button"
                  className={styles['textActionBtn']}
                  disabled={catalogBusy}
                  onClick={() => { void loadCatalogModels() }}
                >
                  {catalogBusy ? t('metadataLoadingCatalog') : t('metadataLoadCatalog')}
                </button>
              )}
              {catalogError !== undefined && (
                <p className={styles['metadataError']} role="alert">
                  {t('metadataCatalogFailed', { message: catalogError })}
                </p>
              )}
            </div>
          ) : (
            enrichedFilteredModels.map(({ model: m, visibility, caps, contextStr, maxTokStr }) => {
              const rowKind = rowKindOf(catalogShown)
              const editDisabled = readOnly || rowKind === undefined
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
                      {m.unverified === true && (
                        <span
                          className={styles['modelBadge']}
                          data-model-badge="unverified"
                          title={t('capUnverifiedHint')}
                        >
                          {t('capUnverifiedBadge')}
                        </span>
                      )}
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
                            className={styles['capIcon']}
                            title={t('capTools')}
                          >
                            <IconTools size={10} />
                          </span>
                        )}
                        {caps.hasReasoning && (
                          <span
                            className={`${styles['capIcon']} ${styles['capIconReasoning']}${caps.hinted.reasoning ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.reasoning ? 'reasoning' : undefined}
                            data-unverified={caps.hinted.reasoning ? 'true' : undefined}
                            title={caps.hinted.reasoning ? `${t('capReasoning')} — ${t('capHintUnverified')}` : t('capReasoning')}
                          >
                            <IconBrain size={10} />
                          </span>
                        )}
                        {caps.hasVision && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.vision ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.vision ? 'vision' : undefined}
                            data-unverified={caps.hinted.vision ? 'true' : undefined}
                            title={caps.hinted.vision ? `${t('capVision')} — ${t('capHintUnverified')}` : t('capVision')}
                          >
                            <IconVision size={10} />
                          </span>
                        )}
                        {(caps.hasAudio || caps.hinted.audio) && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.audio ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.audio ? 'audio' : undefined}
                            data-unverified={caps.hinted.audio ? 'true' : undefined}
                            title={caps.hinted.audio ? `${t('capAudio')} — ${t('capHintUnverified')}` : t('capAudio')}
                          >
                            <IconAudio size={10} />
                          </span>
                        )}
                        {(caps.hasVideo || caps.hinted.video) && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.video ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.video ? 'video' : undefined}
                            data-unverified={caps.hinted.video ? 'true' : undefined}
                            title={caps.hinted.video ? `${t('capVideo')} — ${t('capHintUnverified')}` : t('capVideo')}
                          >
                            <IconVideo size={10} />
                          </span>
                        )}
                        {(caps.hasFiles || caps.hinted.files) && (
                          <span
                            className={`${styles['capIcon']}${caps.hinted.files ? ` ${styles['capIconHint']}` : ''}`}
                            data-hint={caps.hinted.files ? 'files' : undefined}
                            data-unverified={caps.hinted.files ? 'true' : undefined}
                            title={caps.hinted.files ? `${t('capFiles')} — ${t('capHintUnverified')}` : t('capFiles')}
                          >
                            <IconFile size={10} />
                          </span>
                        )}
                        {caps.declaredOnly.map(modality => (
                          <span
                            key={`declared-${modality}`}
                            className={`${styles['capIcon']} ${styles['capIconHint']}`}
                            data-advertised-only={modality}
                            title={t('capDeclaredNotNativeTitle', {
                              capability: modality === 'audio'
                                ? t('capAudio')
                                : modality === 'video' ? t('capVideo') : t('capFiles'),
                            })}
                          >
                            {modality === 'audio'
                              ? <IconAudio size={10} />
                              : modality === 'video' ? <IconVideo size={10} /> : <IconFile size={10} />}
                          </span>
                        ))}
                        {caps.declaredOnly.length > 0 && (
                          <span className={styles['modelBadge']} data-model-badge="declared-not-sent">
                            {t('capDeclaredNotNative')}
                          </span>
                        )}
                        {(caps.hinted.reasoning || caps.hinted.vision || caps.hinted.audio
                          || caps.hinted.video || caps.hinted.files) && (
                          <span className={styles['modelBadge']} data-model-badge="unverified-hint">
                            {t('capHintUnverified')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* One compact metadata action per row: basics and pricing
                      live behind it instead of expanding every row into a
                      card wall. */}
                  <button
                    type="button"
                    className={styles['modelEditBtn']}
                    disabled={editDisabled}
                    onClick={() => {
                      if (rowKind === undefined) return
                      openModelMetadata(m, rowKind)
                    }}
                    title={rowKind === undefined
                      ? inheritedModelsBlocked
                        ? metadataKind === 'deepseek'
                          ? t('metadataDeepseekUnavailable')
                          : t('metadataPiAiInheritedModelsHint')
                        : t('metadataEditingUnavailable')
                      : readOnly ? t('readOnly') : t('editModelMetadata', { id: m.id })}
                    aria-label={t('editModelMetadata', { id: m.id })}
                  >
                    <IconEditOutlineRegular size={13} />
                  </button>

                  {/* Eye Toggle: reflects the picker's verdict; the operator can
                      always override it — clicking a rule/gate-hidden model pins
                      it shown (the shown map beats every hiding source). */}
                  <button
                    type="button"
                    className={`${styles['modelEyeBtn']} ${visibility.hidden ? styles['modelEyeBtnHidden'] : ''}`}
                    disabled={readOnly}
                    onClick={() => handleToggleHide(m.id, visibility.hidden)}
                    title={visibility.hidden
                      ? visibility.reason === null ? t('hiddenClickShow') : t('hiddenInPicker', { reason: visibility.reason })
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

      {editingModel !== undefined && (
        <ModelMetadataDialog
          key={`${editingModel.kind}:${editingModel.modelId}`}
          providerId={providerId}
          modelId={editingModel.modelId}
          kind={editingModel.kind}
          model={editingModel.baseline}
          {...editingModel.inherited === undefined ? {} : { inherited: editingModel.inherited }}
          manualFields={editingModel.manualFields}
          readOnly={readOnly}
          t={t}
          onClose={() => { setEditingModel(undefined) }}
          onSave={({ draft, baselineDraft, resetFields }) => saveModelMetadata(
            editingModel.modelId,
            editingModel.kind,
            draft,
            baselineDraft,
            resetFields,
          )}
        />
      )}
    </div>
  )
}
