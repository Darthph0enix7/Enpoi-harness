/**
 * Pure model-metadata editor logic shared by the Models page and its modal.
 *
 * The editor writes one model's catalog metadata through the existing
 * path-addressed settings API. It never rewrites a whole provider, never
 * touches session history or route references, and never invents a price or a
 * capability: a blank field is an explicit "unset" that lets the adapter's
 * normal resolution answer again.
 *
 * Three storage layouts exist:
 *  - `llm-pi-ai` with a non-empty `models` list edits that list,
 *  - `llm-pi-ai` without one edits the route's `modelOverrides` entry,
 *  - `llm-deepseek` edits its root `models` array.
 *
 * A changed request id is a safe save-as: the old row stays untouched for
 * existing sessions, the new row is appended as a full manual clone, and no
 * history or reference is rewritten. `modelOverrides` has no id field, so an
 * id change is refused there.
 *
 * A supplied `baselineDraft` narrows a conflict retry to the fields the
 * operator actually edited; untouched fresh fields and concurrent cost
 * columns survive. Without one, the legacy full-draft comparison applies.
 *
 * @module ui-settings-models/model-metadata
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The storage layout one metadata row belongs to. */
export type ModelMetadataKind = 'pi-ai-models' | 'pi-ai-catalog' | 'deepseek'

/** One model's editable catalog metadata as text the modal controls. */
export interface ModelMetadataDraft {
  /** Wire request id. Read-only for a catalog override; editable as save-as elsewhere. */
  id: string
  /** Selector label; blank clears it. */
  name: string
  /** Combined context capacity; decimal token count text, blank clears it. */
  contextWindow: string
  /** Input-only capacity; decimal token count text, blank clears it. */
  maxInputTokens: string
  /** Output/per-request capacity; decimal token count text, blank clears it. */
  maxTokens: string
  /** Accepted request modalities. */
  input: string[]
  /** Tool-call support: inherit the catalog, enable, or disable. */
  tools: 'inherit' | 'yes' | 'no'
  /** Reasoning support: inherit the catalog, enable, or disable. */
  reasoning: 'inherit' | 'yes' | 'no'
  /**
   * Reasoning ladder as `level=wire` entries separated by newlines or commas.
   * `false` declares a non-reasoning model; blank clears the field. `off` may
   * leave its wire value empty.
   */
  reasoningEfforts: string
  /** Base input price per million tokens, in the catalog's price unit. */
  inputPrice: string
  /** Base output price per million tokens, in the catalog's price unit. */
  outputPrice: string
  /** Cached-input read price per million tokens. */
  cacheReadPrice: string
  /** Cached-input write price per million tokens. */
  cacheWritePrice: string
  /** models.dev release day (`YYYY-MM-DD`); blank clears it. */
  releaseDate: string
  /** Request-wide price tiers above an input-token threshold. */
  pricingTiers?: readonly {
    /** Input tokens above which this tier prices the whole request. */
    inputTokensAbove: string
    /** Tier input price per million tokens; blank means undisclosed. */
    input: string
    /** Tier output price per million tokens; blank means undisclosed. */
    output: string
  }[]
}

/**
 * The extensible manual-field vocabulary. A row's `manualFields` names the
 * storage fields a provider refresh must not overwrite. `output` is reserved
 * by that vocabulary; this draft version edits `input` only.
 */
export const MODEL_METADATA_FIELDS = [
  'name',
  'contextWindow',
  'maxInputTokens',
  'maxTokens',
  'input',
  'output',
  'tools',
  'reasoning',
  'reasoningEfforts',
  'cost',
  'costTiers',
  'releaseDate',
] as const

/** One canonical storage field a manual row may pin. */
export type ModelMetadataField = (typeof MODEL_METADATA_FIELDS)[number]

/** Machine-readable validation codes; surfaces own all user-facing copy. */
export type ModelMetadataValidationCode =
  | 'required'
  | 'positiveInteger'
  | 'nonnegativeNumber'
  | 'invalidId'
  | 'invalidModality'
  | 'invalidDate'
  | 'invalidEfforts'
  | 'duplicateThreshold'

/** One rejected draft field, identified by its draft-side path. */
export interface ModelMetadataValidationIssue {
  /** Draft field path, e.g. `pricingTiers[1].inputTokensAbove`. */
  field: string
  /** Machine code the surface localizes. */
  code: ModelMetadataValidationCode
}

/** Why a plan could not be built. */
export type ModelMetadataOpsErrorCode =
  | 'invalid-draft'
  | 'model-not-found'
  | 'duplicate-id'
  | 'id-change-not-allowed'

/**
 * A refused plan. The event never contains localized copy: a surface shows
 * `code` through its own dictionary and may inspect `issues` for field marks.
 */
export class ModelMetadataOpsError extends Error {
  /** Stable machine code. */
  readonly code: ModelMetadataOpsErrorCode
  /** Rejected draft fields when `code` is `invalid-draft`. */
  readonly issues: readonly ModelMetadataValidationIssue[]

  /**
   * @param code - stable reason for the refusal.
   * @param issues - rejected fields for an invalid draft.
   */
  constructor(code: ModelMetadataOpsErrorCode, issues: readonly ModelMetadataValidationIssue[] = []) {
    super(`model-metadata: ${code}`)
    this.name = 'ModelMetadataOpsError'
    this.code = code
    this.issues = issues
  }
}

/** Every draft field except the identity, in form order. */
type DraftField = Exclude<keyof ModelMetadataDraft, 'id'>
type PriceDraftField = 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'
type PriceCostKey = 'input' | 'output' | 'cache_read' | 'cache_write'

const DRAFT_FIELDS = [
  'name',
  'contextWindow',
  'maxInputTokens',
  'maxTokens',
  'input',
  'tools',
  'reasoning',
  'reasoningEfforts',
  'inputPrice',
  'outputPrice',
  'cacheReadPrice',
  'cacheWritePrice',
  'releaseDate',
  'pricingTiers',
] as const satisfies readonly DraftField[]

const DRAFT_FIELD_SET: ReadonlySet<string> = new Set(DRAFT_FIELDS)

/** One draft price field and the canonical models.dev cost key it edits. */
interface PriceField {
  readonly draft: PriceDraftField
  readonly cost: PriceCostKey
  readonly alias: string | undefined
}

const PRICE_FIELDS: readonly PriceField[] = [
  { draft: 'inputPrice', cost: 'input', alias: undefined },
  { draft: 'outputPrice', cost: 'output', alias: undefined },
  { draft: 'cacheReadPrice', cost: 'cache_read', alias: 'cacheRead' },
  { draft: 'cacheWritePrice', cost: 'cache_write', alias: 'cacheWrite' },
]

const CAPACITY_FIELDS = ['contextWindow', 'maxInputTokens', 'maxTokens'] as const
/** Exact settings entries that own the direct DeepSeek root model array. */
const DEEPSEEK_NAMESPACES: ReadonlySet<string> = new Set([
  'llm-deepseek',
  'llm-deepseek-api-key',
  'llm-deepseek-account',
])
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const PI_MODALITIES: readonly string[] = ['text', 'image', 'audio', 'video', 'pdf']
const DEEPSEEK_MODALITIES: readonly string[] = ['text', 'image']
const LEGACY_MANUAL_FIELDS: readonly ModelMetadataField[] = [
  'name',
  'contextWindow',
  'maxInputTokens',
  'maxTokens',
  'input',
  'reasoning',
  'reasoningEfforts',
]
const DISALLOWED_ID = '__proto__'

interface ParsedEfforts {
  readonly ok: boolean
  readonly value: false | Record<string, string | null> | undefined
}

interface IndexedTier {
  readonly index: number
  readonly row: NonNullable<ModelMetadataDraft['pricingTiers']>[number]
}

/** Whether a value is a plain JSON object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a draft field round-trips to a non-empty stored value. */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  if (typeof value === 'string') return value.length > 0
  return typeof value === 'number' || typeof value === 'boolean'
}

/** Spell a stored scalar back as trimmed field text. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Deep JSON equality for stored/draft values. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}

/**
 * Both spellings of a layout's input declaration, primary first. A stored row
 * can carry either one (both, after a hand edit); a touched input edit writes
 * only the primary and removes the alias.
 */
function inputKeys(kind: ModelMetadataKind): readonly [string, string] {
  return kind === 'deepseek' ? ['inputModalities', 'input'] : ['input', 'inputModalities']
}

/** Whether either stored input spelling declares a value. */
function hasInputValue(row: Record<string, unknown>, kind: ModelMetadataKind): boolean {
  return inputKeys(kind).some(key => hasValue(row[key]))
}

/** Whether a storage field exists for this layout's model schema. */
function fieldSupported(kind: ModelMetadataKind, field: DraftField | ModelMetadataField): boolean {
  if (kind !== 'deepseek') return true
  return field !== 'maxInputTokens'
    && field !== 'tools'
    && field !== 'reasoning'
    && field !== 'reasoningEfforts'
}

/** Whether a draft field is one of the four merged price columns. */
function isPriceField(field: DraftField): field is PriceDraftField {
  return field === 'inputPrice'
    || field === 'outputPrice'
    || field === 'cacheReadPrice'
    || field === 'cacheWritePrice'
}

/** Map a reset-field spelling onto the draft field it clears. */
function normalizeResetFields(fields: readonly string[]): Set<DraftField> {
  const reset = new Set<DraftField>()
  for (const raw of fields) {
    const name = raw.trim()
    if (name === '') continue
    if (name === 'input' || name === 'inputModalities') {
      reset.add('input')
      continue
    }
    if (name === 'pricingTiers' || name === 'costTiers') {
      reset.add('pricingTiers')
      continue
    }
    if (name === 'inputPrice' || name === 'cost.input') {
      reset.add('inputPrice')
      continue
    }
    if (name === 'outputPrice' || name === 'cost.output') {
      reset.add('outputPrice')
      continue
    }
    if (name === 'cacheReadPrice' || name === 'cost.cache_read' || name === 'cacheRead' || name === 'cache_read') {
      reset.add('cacheReadPrice')
      continue
    }
    if (name === 'cacheWritePrice' || name === 'cost.cache_write' || name === 'cacheWrite' || name === 'cache_write') {
      reset.add('cacheWritePrice')
      continue
    }
    if (name === 'cost') {
      reset.add('inputPrice')
      reset.add('outputPrice')
      reset.add('cacheReadPrice')
      reset.add('cacheWritePrice')
      continue
    }
    if (name === 'output') continue
    if (DRAFT_FIELD_SET.has(name)) reset.add(name as DraftField)
  }
  return reset
}

/** Normalize one existing manual-field name to the shared vocabulary. */
function normalizeManualField(field: string): string {
  if (field === 'input' || field === 'inputModalities') return 'input'
  if (field === 'pricingTiers') return 'costTiers'
  return field
}

/** Read a stored manual-field array without trusting malformed entries. */
function normalizedManualFields(value: readonly unknown[]): string[] {
  const fields: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const field = normalizeManualField(raw)
    if (!fields.includes(field)) fields.push(field)
  }
  return fields
}

/** The fields a legacy `source: manual` row froze before `manualFields` existed. */
function legacyManualFields(row: Record<string, unknown>, kind: ModelMetadataKind): string[] {
  const fields: string[] = []
  for (const field of LEGACY_MANUAL_FIELDS) {
    if (!fieldSupported(kind, field)) continue
    const present = field === 'input' ? hasInputValue(row, kind) : hasValue(row[field])
    if (present) fields.push(field)
  }
  return fields
}

/** Canonical manual-field order, with unknown future names kept last. */
function sortedManualFields(fields: readonly string[]): string[] {
  const order = new Map<string, number>()
  MODEL_METADATA_FIELDS.forEach((field, index) => {
    order.set(field, index)
  })
  return [...fields].sort((left, right) =>
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
}

/** Whether two manual-field arrays describe the same ordered list. */
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
}

/** One declared input list, preferring the layout's own storage field. */
function declaredInput(model: Record<string, unknown>, kind: ModelMetadataKind): string[] {
  const [primary, alias] = inputKeys(kind)
  const primaryValue = model[primary]
  const aliasValue = model[alias]
  const list = Array.isArray(primaryValue) ? primaryValue : Array.isArray(aliasValue) ? aliasValue : []
  return list.filter((value): value is string => typeof value === 'string')
}

/** The modalities the layout's host schema accepts. */
function allowedModalities(kind: ModelMetadataKind): readonly string[] {
  return kind === 'deepseek' ? DEEPSEEK_MODALITIES : PI_MODALITIES
}

/** Normalize a draft modality list to the layout's declared vocabulary. */
function normalizedInput(values: readonly string[], kind: ModelMetadataKind): string[] {
  const offered = allowedModalities(kind)
  const result: string[] = []
  for (const value of values) {
    if (!offered.includes(value) || result.includes(value)) continue
    result.push(value)
  }
  return result
}

/** Preserve declaration order while dropping duplicate ids. */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Serialize a stored reasoning ladder into the modal's text form. */
function effortText(value: unknown): string {
  if (value === false) return 'false'
  if (!isRecord(value)) return ''
  const lines: string[] = []
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(value, level)) continue
    const wire = value[level]
    if (wire === null) {
      lines.push(`${level}=`)
      continue
    }
    if (typeof wire !== 'string') continue
    lines.push(`${level}=${wire}`)
  }
  return lines.join('\n')
}

/** Whether a level is one this schema accepts. */
function isThinkingLevel(value: string): boolean {
  return THINKING_LEVELS.some(level => level === value)
}

/** Parse the modal's ladder text into a persistable answer. */
function parseReasoningEfforts(text: string): ParsedEfforts {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: undefined }
  if (trimmed.toLowerCase() === 'false') return { ok: true, value: false }
  const values: Record<string, string | null> = {}
  let thinking = false
  for (const part of trimmed.split(/[\n,]+/)) {
    const entry = part.trim()
    if (entry === '') continue
    const separator = entry.indexOf('=')
    if (separator < 0) return { ok: false, value: undefined }
    const level = entry.slice(0, separator).trim()
    const wire = entry.slice(separator + 1).trim()
    if (!isThinkingLevel(level) || Object.hasOwn(values, level)) return { ok: false, value: undefined }
    if (level === 'off') {
      values.off = wire === '' ? null : wire
      continue
    }
    if (wire === '') return { ok: false, value: undefined }
    values[level] = wire
    thinking = true
  }
  if (!thinking) return { ok: false, value: undefined }
  const ordered: Record<string, string | null> = {}
  for (const level of THINKING_LEVELS) {
    if (Object.hasOwn(values, level)) ordered[level] = values[level] ?? null
  }
  return { ok: true, value: ordered }
}

/** Whether a non-blank capacity is a positive safe integer. */
function isPositiveIntegerText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (!/^\d+$/.test(trimmed)) return false
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0
}

/** Parse a blank-or-capacity text; validity is checked separately. */
function parsePositiveInteger(text: string): number | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

/** Whether a non-blank price is finite and non-negative. */
function isNonnegativeNumberText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return false
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0
}

/** Parse a blank-or-price text; validity is checked separately. */
function parseNonnegativeNumber(text: string): number | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

/** Whether a non-blank date is a real calendar day in `YYYY-MM-DD` form. */
function isDateText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false
  const parsed = new Date(`${trimmed}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed
}

/** Parse a blank-or-date text; validity is checked separately. */
function parseDateText(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Keep only non-empty tier rows, with their original draft positions. */
function pricingTierRows(tiers: NonNullable<ModelMetadataDraft['pricingTiers']>): IndexedTier[] {
  const rows: IndexedTier[] = []
  for (const [index, row] of tiers.entries()) {
    if (row.inputTokensAbove.trim() === '' && row.input.trim() === '' && row.output.trim() === '') continue
    rows.push({ index, row })
  }
  return rows
}

/** The draft text form of one stored scalar. */
function priceText(cost: Record<string, unknown>, key: string, alias: string | undefined): string {
  const value = cost[key] ?? (alias === undefined ? undefined : cost[alias])
  return valueText(value)
}

/** The draft text form of one stored cost tier list. */
function tierDrafts(value: unknown): NonNullable<ModelMetadataDraft['pricingTiers']>[number][] {
  if (!Array.isArray(value)) return []
  const tiers: NonNullable<ModelMetadataDraft['pricingTiers']>[number][] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    tiers.push({
      inputTokensAbove: valueText(raw.inputTokensAbove),
      input: valueText(raw.input),
      output: valueText(raw.output),
    })
  }
  return tiers
}

/**
 * Project one stored model row into the modal's text draft. A catalog
 * override entry carries no id, so its draft is
 * `{ ...metadataDraftOf(overrideEntry, 'pi-ai-catalog'), id: modelId }`.
 */
export function metadataDraftOf(model: Record<string, unknown>, kind: ModelMetadataKind): ModelMetadataDraft {
  const cost = isRecord(model.cost) ? model.cost : {}
  return {
    id: valueText(model.id),
    name: valueText(model.name),
    contextWindow: valueText(model.contextWindow),
    maxInputTokens: valueText(model.maxInputTokens),
    maxTokens: valueText(model.maxTokens),
    input: declaredInput(model, kind),
    tools: model.tools === true ? 'yes' : model.tools === false ? 'no' : 'inherit',
    reasoning: model.reasoning === true ? 'yes' : model.reasoning === false ? 'no' : 'inherit',
    reasoningEfforts: effortText(model.reasoningEfforts),
    inputPrice: priceText(cost, 'input', undefined),
    outputPrice: priceText(cost, 'output', undefined),
    cacheReadPrice: priceText(cost, 'cache_read', 'cacheRead'),
    cacheWritePrice: priceText(cost, 'cache_write', 'cacheWrite'),
    releaseDate: valueText(model.releaseDate),
    pricingTiers: tierDrafts(model.costTiers),
  }
}

/** Validate one draft against its layout's storage rules. */
export function validateMetadataDraft(
  draft: ModelMetadataDraft,
  kind: ModelMetadataKind,
): ModelMetadataValidationIssue[] {
  const issues: ModelMetadataValidationIssue[] = []
  const id = draft.id.trim()
  if (id === '') issues.push({ field: 'id', code: 'required' })
  else if (id === DISALLOWED_ID || /[\u0000-\u001f\u007f]/.test(id)) {
    issues.push({ field: 'id', code: 'invalidId' })
  }
  if (draft.input.some(value => !allowedModalities(kind).includes(value))) {
    issues.push({ field: 'input', code: 'invalidModality' })
  }
  for (const field of CAPACITY_FIELDS) {
    if (!fieldSupported(kind, field)) continue
    if (!isPositiveIntegerText(draft[field])) issues.push({ field, code: 'positiveInteger' })
  }
  if (fieldSupported(kind, 'reasoningEfforts') && !parseReasoningEfforts(draft.reasoningEfforts).ok) {
    issues.push({ field: 'reasoningEfforts', code: 'invalidEfforts' })
  }
  for (const price of PRICE_FIELDS) {
    if (!isNonnegativeNumberText(draft[price.draft])) {
      issues.push({ field: price.draft, code: 'nonnegativeNumber' })
    }
  }
  if (!isDateText(draft.releaseDate)) issues.push({ field: 'releaseDate', code: 'invalidDate' })
  if (draft.pricingTiers !== undefined) {
    const thresholds = new Set<number>()
    for (const { index, row } of pricingTierRows(draft.pricingTiers)) {
      const thresholdText = row.inputTokensAbove.trim()
      if (thresholdText === '') {
        issues.push({ field: `pricingTiers[${String(index)}].inputTokensAbove`, code: 'required' })
      } else if (!isPositiveIntegerText(thresholdText)) {
        issues.push({ field: `pricingTiers[${String(index)}].inputTokensAbove`, code: 'positiveInteger' })
      } else {
        const threshold = Number(thresholdText)
        if (thresholds.has(threshold)) {
          issues.push({ field: `pricingTiers[${String(index)}].inputTokensAbove`, code: 'duplicateThreshold' })
        } else {
          thresholds.add(threshold)
        }
      }
      if (row.input.trim() !== '' && !isNonnegativeNumberText(row.input)) {
        issues.push({ field: `pricingTiers[${String(index)}].input`, code: 'nonnegativeNumber' })
      }
      if (row.output.trim() !== '' && !isNonnegativeNumberText(row.output)) {
        issues.push({ field: `pricingTiers[${String(index)}].output`, code: 'nonnegativeNumber' })
      }
    }
  }
  return issues
}

/** Detect the layout for a known settings namespace and its resolved profile. */
export function metadataKindOf(
  settingsNs: string,
  profile: Record<string, unknown>,
): ModelMetadataKind | undefined {
  if (settingsNs === 'llm-pi-ai') {
    if (Array.isArray(profile.models) && profile.models.length > 0) return 'pi-ai-models'
    // `modelOverrides` is refused under endpoint authority, so there is no
    // valid catalog edit there.
    return profile.catalogAuthority === 'endpoint' ? undefined : 'pi-ai-catalog'
  }
  if (DEEPSEEK_NAMESPACES.has(settingsNs)) {
    // Only an explicit, non-empty root catalog has stored rows to edit.
    return Array.isArray(profile.models) && profile.models.length > 0 ? 'deepseek' : undefined
  }
  return undefined
}

/** A capacity's semantic edit value; blank and malformed both mean no value. */
function comparableCapacity(text: string): number | undefined {
  return isPositiveIntegerText(text) ? parsePositiveInteger(text) : undefined
}

/** A price's semantic edit value; blank and malformed both mean no value. */
function comparablePrice(text: string): number | undefined {
  return isNonnegativeNumberText(text) ? parseNonnegativeNumber(text) : undefined
}

/** A release date's semantic edit value; blank and malformed both mean no value. */
function comparableDate(text: string): string | undefined {
  return isDateText(text) ? parseDateText(text) : undefined
}

/** A reasoning ladder's semantic edit value through the existing parser. */
function comparableEfforts(text: string): false | Record<string, string | null> | undefined {
  return parseReasoningEfforts(text).value
}

/** One tier normalized for edit comparison, independent of text formatting. */
interface TierSignature {
  readonly inputTokensAbove: number | undefined
  readonly input: number | undefined
  readonly output: number | undefined
}

/** Normalize a tier list so `01000` and `1000` compare equal. */
function tierSignature(tiers: ModelMetadataDraft['pricingTiers']): TierSignature[] {
  if (tiers === undefined) return []
  return pricingTierRows(tiers).map(({ row }) => ({
    inputTokensAbove: comparableCapacity(row.inputTokensAbove),
    input: comparablePrice(row.input),
    output: comparablePrice(row.output),
  }))
}

/** Every draft field the operator actually changed from the dialog snapshot. */
function editedFields(
  draft: ModelMetadataDraft,
  baseline: ModelMetadataDraft,
  kind: ModelMetadataKind,
  reset: ReadonlySet<DraftField>,
): Set<DraftField> {
  const touched = new Set<DraftField>()
  for (const field of DRAFT_FIELDS) {
    if (!fieldSupported(kind, field)) continue
    if (reset.has(field)) {
      touched.add(field)
      continue
    }
    if (field === 'pricingTiers') {
      if (draft.pricingTiers === undefined) continue
      if (!jsonEqual(tierSignature(draft.pricingTiers), tierSignature(baseline.pricingTiers))) {
        touched.add(field)
      }
      continue
    }
    if (field === 'input') {
      if (!jsonEqual(uniqueStrings(draft.input), uniqueStrings(baseline.input))) touched.add(field)
      continue
    }
    if (isPriceField(field)) {
      if (comparablePrice(draft[field]) !== comparablePrice(baseline[field])) touched.add(field)
      continue
    }
    if (field === 'contextWindow' || field === 'maxInputTokens' || field === 'maxTokens') {
      if (comparableCapacity(draft[field]) !== comparableCapacity(baseline[field])) touched.add(field)
      continue
    }
    if (field === 'reasoningEfforts') {
      if (!jsonEqual(comparableEfforts(draft[field]), comparableEfforts(baseline[field]))) {
        touched.add(field)
      }
      continue
    }
    if (field === 'releaseDate') {
      if (comparableDate(draft[field]) !== comparableDate(baseline[field])) touched.add(field)
      continue
    }
    if (field === 'name') {
      if (valueText(draft.name) !== valueText(baseline.name)) touched.add(field)
      continue
    }
    if (draft[field] !== baseline[field]) touched.add(field)
  }
  return touched
}

/** Every draft field whose value differs from the baseline or was reset. */
function touchedFields(
  draft: ModelMetadataDraft,
  baseline: ModelMetadataDraft,
  kind: ModelMetadataKind,
  reset: ReadonlySet<DraftField>,
): Set<DraftField> {
  const touched = new Set<DraftField>()
  for (const field of DRAFT_FIELDS) {
    if (!fieldSupported(kind, field)) continue
    if (reset.has(field)) {
      touched.add(field)
      continue
    }
    if (field === 'pricingTiers' && draft.pricingTiers === undefined) continue
    if (!jsonEqual(draft[field], baseline[field])) touched.add(field)
  }
  return touched
}

/** Set a field when it carries a value and remove it when blank. */
function setOrDelete(record: Record<string, unknown>, field: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(record, field)
  else record[field] = value
}

/** Build the tier array a draft stores, preserving unknown keys by threshold. */
function buildCostTiers(
  tiers: NonNullable<ModelMetadataDraft['pricingTiers']>,
  existing: unknown,
): Array<Record<string, unknown>> {
  const prior = new Map<number, Record<string, unknown>>()
  if (Array.isArray(existing)) {
    for (const raw of existing) {
      if (!isRecord(raw)) continue
      const text = valueText(raw.inputTokensAbove)
      if (text === '' || !isPositiveIntegerText(text)) continue
      prior.set(Number(text), raw)
    }
  }
  const result = new Map<number, Record<string, unknown>>()
  for (const { row } of pricingTierRows(tiers)) {
    const threshold = Number(row.inputTokensAbove.trim())
    const tier: Record<string, unknown> = {
      ...(prior.get(threshold) ?? {}),
      inputTokensAbove: threshold,
    }
    setOrDelete(tier, 'input', parseNonnegativeNumber(row.input))
    setOrDelete(tier, 'output', parseNonnegativeNumber(row.output))
    result.set(threshold, tier)
  }
  return [...result.values()].sort((left, right) =>
    Number(left.inputTokensAbove) - Number(right.inputTokensAbove))
}

/** Apply every touched draft field to a detached copy of one stored row. */
function applyTouchedFields(
  row: Record<string, unknown>,
  draft: ModelMetadataDraft,
  kind: ModelMetadataKind,
  touched: ReadonlySet<DraftField>,
  reset: ReadonlySet<DraftField>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row }
  for (const field of DRAFT_FIELDS) {
    if (!touched.has(field)) continue
    if (isPriceField(field)) continue
    if (field === 'pricingTiers') {
      if (reset.has(field)) {
        delete next.costTiers
      } else {
        const tiers = buildCostTiers(draft.pricingTiers as NonNullable<ModelMetadataDraft['pricingTiers']>, row.costTiers)
        setOrDelete(next, 'costTiers', tiers.length === 0 ? undefined : tiers)
      }
      continue
    }
    switch (field) {
      case 'name':
        setOrDelete(next, 'name', reset.has(field) || valueText(draft.name) === '' ? undefined : valueText(draft.name))
        break
      case 'contextWindow':
      case 'maxInputTokens':
      case 'maxTokens':
        setOrDelete(next, field, reset.has(field) ? undefined : parsePositiveInteger(draft[field]))
        break
      case 'input': {
        const [primary, alias] = inputKeys(kind)
        const input = reset.has(field) ? [] : normalizedInput(draft.input, kind)
        setOrDelete(next, primary, input.length === 0 ? undefined : input)
        setOrDelete(next, alias, undefined)
        break
      }
      case 'tools':
      case 'reasoning': {
        const value = reset.has(field) ? 'inherit' : draft[field]
        setOrDelete(next, field, value === 'yes' ? true : value === 'no' ? false : undefined)
        break
      }
      case 'reasoningEfforts':
        setOrDelete(next, field, reset.has(field) ? undefined : parseReasoningEfforts(draft.reasoningEfforts).value)
        break
      case 'releaseDate':
        setOrDelete(next, field, reset.has(field) ? undefined : parseDateText(draft.releaseDate))
        break
    }
  }
  const touchedPrices = PRICE_FIELDS.filter(price => touched.has(price.draft))
  if (touchedPrices.length > 0) {
    const cost: Record<string, unknown> = isRecord(row.cost) ? { ...row.cost } : {}
    for (const price of touchedPrices) {
      Reflect.deleteProperty(cost, price.cost)
      if (price.alias !== undefined) Reflect.deleteProperty(cost, price.alias)
      const value = reset.has(price.draft) ? undefined : parseNonnegativeNumber(draft[price.draft])
      if (value !== undefined) cost[price.cost] = value
    }
    if (Object.keys(cost).length === 0) delete next.cost
    else next.cost = cost
  }
  return next
}

/** Storage fields whose whole value changes map to one top-level leaf. */
function topLevelFields(kind: ModelMetadataKind): string[] {
  return [
    'name',
    'contextWindow',
    ...fieldSupported(kind, 'maxInputTokens') ? ['maxInputTokens'] : [],
    'maxTokens',
    ...inputKeys(kind),
    ...fieldSupported(kind, 'tools') ? ['tools'] : [],
    ...fieldSupported(kind, 'reasoning') ? ['reasoning'] : [],
    ...fieldSupported(kind, 'reasoningEfforts') ? ['reasoningEfforts'] : [],
    'costTiers',
    'releaseDate',
  ]
}

/** Path ops for one changed top-level field, never a whole provider. */
function topLevelOps(
  row: Record<string, unknown>,
  next: Record<string, unknown>,
  basePath: readonly string[],
  kind: ModelMetadataKind,
): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = []
  for (const field of topLevelFields(kind)) {
    const beforeHas = Object.hasOwn(row, field)
    const afterHas = Object.hasOwn(next, field)
    if (afterHas) {
      if (!beforeHas || !jsonEqual(row[field], next[field])) {
        ops.push({ op: 'set', path: [...basePath, field], value: next[field] as JsonValue })
      }
    } else if (beforeHas) {
      ops.push({ op: 'unset', path: [...basePath, field] })
    }
  }
  return ops
}

/** Path ops for changed price columns, merging over the route's other cost keys. */
function priceOps(
  row: Record<string, unknown>,
  next: Record<string, unknown>,
  basePath: readonly string[],
  touched: ReadonlySet<DraftField>,
): SettingsPathOpView[] {
  const touchedPrices = PRICE_FIELDS.filter(price => touched.has(price.draft))
  if (touchedPrices.length === 0) return []
  const before = isRecord(row.cost) ? row.cost : undefined
  const after = isRecord(next.cost) ? next.cost : undefined
  if (after === undefined) {
    return before === undefined && !Object.hasOwn(row, 'cost')
      ? []
      : [{ op: 'unset', path: [...basePath, 'cost'] }]
  }
  const beforeRecord = before ?? {}
  const ops: SettingsPathOpView[] = []
  for (const price of touchedPrices) {
    if (price.alias !== undefined && Object.hasOwn(beforeRecord, price.alias) && !Object.hasOwn(after, price.alias)) {
      ops.push({ op: 'unset', path: [...basePath, 'cost', price.alias] })
    }
    if (Object.hasOwn(after, price.cost)) {
      if (!Object.hasOwn(beforeRecord, price.cost) || !jsonEqual(beforeRecord[price.cost], after[price.cost])) {
        ops.push({ op: 'set', path: [...basePath, 'cost', price.cost], value: after[price.cost] as JsonValue })
      }
    } else if (Object.hasOwn(beforeRecord, price.cost)) {
      ops.push({ op: 'unset', path: [...basePath, 'cost', price.cost] })
    }
  }
  return ops
}

/** Manual-field and source ops for one edited row. */
function manualOps(
  row: Record<string, unknown>,
  next: Record<string, unknown>,
  kind: ModelMetadataKind,
  touched: ReadonlySet<DraftField>,
  basePath: readonly string[],
): SettingsPathOpView[] {
  const marker = Array.isArray(row.manualFields) ? row.manualFields : undefined
  const seeded = row.source === 'manual' && marker === undefined ? legacyManualFields(row, kind) : []
  const manual = new Set(marker === undefined ? seeded : normalizedManualFields(marker))
  for (const field of touched) {
    for (const marker of manualFieldsForDraftField(field)) {
      const present = field === 'input'
        ? hasInputValue(next, kind)
        : hasValue(next[marker])
      if (present) manual.add(marker)
      else manual.delete(marker)
    }
  }
  const desired = sortedManualFields([...manual])
  const ops: SettingsPathOpView[] = []
  if (desired.length === 0) {
    // Only an explicit clear unpins the row: a dirty dialog that changed only
    // a field this layout cannot store must not retire the manual marker.
    if (touched.size > 0 || seeded.length > 0) {
      if (Object.hasOwn(row, 'manualFields')) {
        ops.push({ op: 'unset', path: [...basePath, 'manualFields'] })
      }
      if (row.source === 'manual') ops.push({ op: 'unset', path: [...basePath, 'source'] })
    }
    return ops
  }
  if (row.source !== 'manual') ops.push({ op: 'set', path: [...basePath, 'source'], value: 'manual' })
  if (!sameStrings(row.manualFields, desired)) {
    ops.push({ op: 'set', path: [...basePath, 'manualFields'], value: desired as JsonValue })
  }
  return ops
}

/** Storage fields a touched draft field pins. */
function manualFieldsForDraftField(field: DraftField): string[] {
  if (field === 'input') return ['input']
  if (field === 'inputPrice' || field === 'outputPrice' || field === 'cacheReadPrice' || field === 'cacheWritePrice') {
    return ['cost']
  }
  if (field === 'pricingTiers') return ['costTiers']
  return [field]
}

/** The manual marker a freshly cloned manual row carries. */
function cloneManualFields(row: Record<string, unknown>, kind: ModelMetadataKind): string[] {
  const fields: string[] = []
  for (const field of MODEL_METADATA_FIELDS) {
    if (!fieldSupported(kind, field)) continue
    const present = field === 'input' ? hasInputValue(row, kind) : hasValue(row[field])
    if (present) fields.push(field)
  }
  return sortedManualFields(fields)
}

/** The fresh row an id change appends; the old row stays untouched. */
function clonedManualRow(
  row: Record<string, unknown>,
  draft: ModelMetadataDraft,
  kind: ModelMetadataKind,
  touched: ReadonlySet<DraftField>,
  reset: ReadonlySet<DraftField>,
  id: string,
): Record<string, unknown> {
  const next = applyTouchedFields(row, draft, kind, touched, reset)
  next.id = id
  next.source = 'manual'
  next.manualFields = cloneManualFields(next, kind)
  return next
}

/** Compare an edited row with its stored form and return only changed leaves. */
function editOps(
  row: Record<string, unknown>,
  next: Record<string, unknown>,
  basePath: readonly string[],
  kind: ModelMetadataKind,
  touched: ReadonlySet<DraftField>,
): SettingsPathOpView[] {
  return [
    ...topLevelOps(row, next, basePath, kind),
    ...priceOps(row, next, basePath, touched),
    ...manualOps(row, next, kind, touched, basePath),
  ]
}

/** Refuse a stale dialog snapshot whose id no longer names the fresh row. */
function assertBaselineId(baseline: ModelMetadataDraft | undefined, expected: string): void {
  if (baseline === undefined || baseline.id.trim() === expected) return
  throw new ModelMetadataOpsError('invalid-draft', [{ field: 'id', code: 'invalidId' }])
}

/** Find one row by id in the fresh array; never trust a stored index. */
function rowIndexById(models: readonly unknown[], modelId: string): number {
  const wanted = modelId.trim()
  let found = -1
  for (const [index, raw] of models.entries()) {
    if (!isRecord(raw) || valueText(raw.id) !== wanted) continue
    if (found !== -1) throw new ModelMetadataOpsError('duplicate-id')
    found = index
  }
  if (found === -1) throw new ModelMetadataOpsError('model-not-found')
  return found
}

/** Refuse a save-as whose new id already names another row. */
function assertNewIdFree(models: readonly unknown[], index: number, id: string): void {
  for (const [at, raw] of models.entries()) {
    if (at !== index && isRecord(raw) && valueText(raw.id) === id) {
      throw new ModelMetadataOpsError('duplicate-id')
    }
  }
}

/** Plan one row edit in a `models` array. */
function modelsOps(
  input: BuildModelMetadataOpsInput,
  kind: 'pi-ai-models' | 'deepseek',
  models: readonly unknown[],
  basePath: readonly string[],
  reset: ReadonlySet<DraftField>,
): SettingsPathOpView[] {
  const index = rowIndexById(models, input.modelId)
  const stored = models[index]
  /* v8 ignore next -- rowIndexById only returns an index whose row is a record */
  if (!isRecord(stored)) throw new ModelMetadataOpsError('model-not-found')
  const freshDraft = metadataDraftOf(stored, kind)
  const comparison = input.baselineDraft ?? freshDraft
  const touched = input.baselineDraft === undefined
    ? touchedFields(input.draft, comparison, kind, reset)
    : editedFields(input.draft, comparison, kind, reset)
  const storedId = valueText(stored.id)
  assertBaselineId(input.baselineDraft, storedId)
  const id = input.draft.id.trim()
  if (id !== storedId) {
    assertNewIdFree(models, index, id)
    const next = clonedManualRow(stored, input.draft, kind, touched, reset, id)
    return [{ op: 'set', path: [...basePath, String(models.length)], value: next as JsonValue }]
  }
  const next = applyTouchedFields(stored, input.draft, kind, touched, reset)
  return editOps(stored, next, [...basePath, String(index)], kind, touched)
}

/** One metadata write plan request. */
export interface BuildModelMetadataOpsInput {
  /** Storage layout being edited. */
  kind: ModelMetadataKind
  /** pi-ai route key; ignored for the root DeepSeek section. */
  providerId: string
  /** The row's current id, used to find it in the fresh profile by id. */
  modelId: string
  /**
   * Fresh settings section for `deepseek`, or the fresh route profile for
   * pi-ai. A catalog-override draft is initialized with
   * `{ ...metadataDraftOf(overrideEntry, 'pi-ai-catalog'), id: modelId }`, so
   * a blank field clears only its override leaf, an absent one inherits the
   * installed catalog, and the required id names the override key.
   */
  profile: Record<string, unknown>
  /** The modal's current values. */
  draft: ModelMetadataDraft
  /**
   * The dialog's initial draft. When supplied, only fields the operator
   * actually changed are applied to the fresh profile, so a concurrent writer's
   * untouched fields survive a conflict retry. Omission keeps the legacy
   * full-draft comparison for callers that have not adopted it yet.
   */
  baselineDraft?: ModelMetadataDraft
  /** Canonical storage or draft names the operator explicitly cleared. */
  resetFields?: readonly string[]
}

/**
 * Build the leaf operations for one metadata edit.
 * @param input - layout, fresh profile, current row id, draft, and explicit resets.
 * @returns path operations against the namespace's fresh document.
 * @throws {ModelMetadataOpsError} when the draft is invalid, the row is gone,
 * an id collides, or a catalog override tries to change its key.
 */
export function buildModelMetadataOps(input: BuildModelMetadataOpsInput): SettingsPathOpView[] {
  const issues = validateMetadataDraft(input.draft, input.kind)
  if (issues.length > 0) throw new ModelMetadataOpsError('invalid-draft', issues)
  const reset = normalizeResetFields(input.resetFields ?? [])
  if (input.kind === 'deepseek') {
    const models = Array.isArray(input.profile.models) ? input.profile.models : []
    return modelsOps(input, 'deepseek', models, ['models'], reset)
  }
  const models = Array.isArray(input.profile.models) ? input.profile.models : []
  if (input.kind === 'pi-ai-models') {
    return modelsOps(input, 'pi-ai-models', models, ['providers', input.providerId, 'models'], reset)
  }
  const wanted = input.modelId.trim()
  if (wanted === '') throw new ModelMetadataOpsError('model-not-found')
  if (input.draft.id.trim() !== wanted) throw new ModelMetadataOpsError('id-change-not-allowed')
  assertBaselineId(input.baselineDraft, wanted)
  const overrides = isRecord(input.profile.modelOverrides) ? input.profile.modelOverrides : {}
  let key: string | undefined
  for (const candidate of Object.keys(overrides)) {
    if (candidate.trim() !== wanted) continue
    if (key !== undefined) throw new ModelMetadataOpsError('duplicate-id')
    key = candidate
  }
  const entryPath = ['providers', input.providerId, 'modelOverrides', key ?? wanted]
  const stored = key === undefined ? {} : overrides[key]
  const baselineModel = isRecord(stored) ? stored : {}
  const freshDraft = metadataDraftOf(baselineModel, 'pi-ai-catalog')
  const comparison = input.baselineDraft ?? freshDraft
  const touched = input.baselineDraft === undefined
    ? touchedFields(input.draft, comparison, 'pi-ai-catalog', reset)
    : editedFields(input.draft, comparison, 'pi-ai-catalog', reset)
  const next = applyTouchedFields(baselineModel, input.draft, 'pi-ai-catalog', touched, reset)
  return [
    ...topLevelOps(baselineModel, next, entryPath, 'pi-ai-catalog'),
    ...priceOps(baselineModel, next, entryPath, touched),
  ]
}
