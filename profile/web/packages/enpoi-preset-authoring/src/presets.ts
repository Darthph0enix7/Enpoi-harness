/**
 * Preset authoring model — pure helpers for cloning a base preset, editing
 * only the user-owned fields, and validating the manual-authoring input.
 *
 * Parity law: the shared persona PREFIX belongs to the cache-paired built-ins
 * and is copied byte-identically on clone, never rewritten. Only the
 * per-preset SUFFIX (the doctrine) is user-editable.
 */

/** Shipped preset ids: the fleet presets the profile declares and the upstream rows it disables. */
export const BUILT_IN_PRESET_IDS: ReadonlySet<string> = new Set([
  'orchestrator',
  'sysadmin',
  'creator',
  'standard',
  'ptc',
  'minimal',
  'cordis',
])

/** Largest accepted suffix, in characters (persona doctrine; presets ship up to ~6.6k). */
export const MAX_SUFFIX_CHARS = 32_768

/** General-purpose compose-row view of a preset's plugin list. */
export interface PresetPluginRow {
  id?: unknown
  name?: unknown
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** Compose-row view of one preset declaration. */
export interface PresetConfigRow {
  id?: unknown
  name?: unknown
  description?: unknown
  order?: unknown
  plugins?: unknown
}

/** Kebab-case preset id (`[a-z0-9]+(-[a-z0-9]+)*`). */
export function isPresetId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** Array of plugin rows, or an empty list when the config carries none. */
function pluginRows(config: PresetConfigRow): PresetPluginRow[] {
  return Array.isArray(config.plugins) ? config.plugins as PresetPluginRow[] : []
}

/** The persona row of a preset, when it declares one. */
function personaRow(config: PresetConfigRow): PresetPluginRow | undefined {
  return pluginRows(config).find(row => row.id === 'persona')
}

/** The persona suffix a preset declares, or undefined when it has no persona row. */
export function personaSuffixOf(config: PresetConfigRow | undefined): string | undefined {
  if (config === undefined) return undefined
  const suffix = personaRow(config)?.config?.suffix
  return typeof suffix === 'string' ? suffix : undefined
}

/** Whether a preset declares a persona row with a non-empty prefix (the clone requirement). */
export function hasSharedPersona(config: PresetConfigRow | undefined): boolean {
  if (config === undefined) return false
  const prefix = personaRow(config)?.config?.prefix
  return typeof prefix === 'string' && prefix !== ''
}

/**
 * Replace only the persona suffix across a preset's plugin list.
 * @param plugins - the composed plugin rows to copy.
 * @param suffix - the user-authored doctrine.
 * @returns a detached plugin list whose persona prefix is byte-identical.
 * @throws when the preset declares no persona row or no shared prefix.
 */
export function withPersonaSuffix(plugins: unknown, suffix: string): PresetPluginRow[] {
  const copy = structuredClone(Array.isArray(plugins) ? plugins as PresetPluginRow[] : [])
  const persona = copy.find(row => row.id === 'persona')
  if (persona === undefined || persona.config === undefined) {
    throw new Error('preset declares no persona row')
  }
  const prefix = persona.config.prefix
  if (typeof prefix !== 'string' || prefix === '') {
    throw new Error('preset persona declares no shared prefix')
  }
  persona.config = { ...persona.config, prefix, suffix }
  return copy
}

/** The next display order after every current preset. */
export function nextPresetOrder(configs: readonly PresetConfigRow[]): number {
  let max = 0
  for (const config of configs) {
    if (typeof config.order === 'number' && Number.isFinite(config.order)) max = Math.max(max, config.order)
  }
  return max + 1
}

/** One clone request, already validated. */
export interface NewPresetInput {
  id: string
  name: string
  description: string
  suffix: string
  order: number
}

/**
 * Clone a base preset into a new user preset.
 * @param base - the base preset's composed config.
 * @param input - validated clone input.
 * @returns the new preset config with the base's composition and the new suffix.
 * @throws when the base declares no usable persona row.
 */
export function newPresetConfig(base: PresetConfigRow, input: NewPresetInput): PresetConfigRow {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    order: input.order,
    plugins: withPersonaSuffix(base.plugins, input.suffix),
  }
}

/** The validated fields of a create or update request. */
export interface PresetInput {
  id?: string
  name: string
  description: string
  suffix: string
}

/**
 * Validate one authoring request.
 * @param input - raw user input.
 * @param requireId - whether the id must be present and fresh (create).
 * @returns the first problem, or undefined when the input is usable.
 */
export function validatePresetInput(input: PresetInput, requireId: boolean): string | undefined {
  if (requireId) {
    if (input.id === undefined || input.id === '') return 'missing or invalid "id"'
    if (!isPresetId(input.id)) return `invalid preset id "${input.id}": expected kebab-case ([a-z0-9]+(-[a-z0-9]+)*)`
    if (input.id.length > 48) return `preset id "${input.id}" is longer than 48 characters`
    if (BUILT_IN_PRESET_IDS.has(input.id)) return `preset id "${input.id}" is reserved by a shipped preset`
  }
  if (input.name === '') return 'missing or invalid "name"'
  if (input.name.length > 64) return 'preset name is longer than 64 characters'
  if (input.description.length > 400) return 'preset description is longer than 400 characters'
  if (input.suffix === '') return 'missing or invalid "suffix"'
  if (input.suffix.length > MAX_SUFFIX_CHARS) return `persona is longer than ${MAX_SUFFIX_CHARS} characters`
  return undefined
}
