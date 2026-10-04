/**
 * Custom-tool model — pure parsing, validation, and command rendering for
 * operator-authored tools (`enpoi-orchestration.customTools`).
 *
 * Rendering is the security boundary: every parameter is substituted as a
 * POSIX single-quoted shell word, so a value can never break out of its
 * argument. The rendered command then flows through the same policy guard as
 * bash (see enpoi-capabilities `tools/pre-execute`), which is what decides
 * ask/deny for dangerous verbs.
 */

/** Tool-name prefix every custom tool registers under. */
export const CUSTOM_TOOL_PREFIX = 'custom_'

/** Largest accepted command template, in characters. */
export const MAX_COMMAND_CHARS = 8192

/** Largest accepted parameter count per tool. */
export const MAX_PARAMS = 16

/** Largest accepted tool description, in characters. */
export const MAX_DESCRIPTION_CHARS = 2000

/** Largest accepted display name, in characters. */
export const MAX_NAME_CHARS = 64

/** Parameter value types a custom tool may declare. */
export type CustomToolParamType = 'string' | 'number' | 'boolean'

/** One declared parameter. */
export interface CustomToolParam {
  name: string
  type: CustomToolParamType
  required: boolean
  description: string
}

/** One operator-authored tool record. */
export interface CustomToolRecord {
  id: string
  name: string
  description: string
  params: CustomToolParam[]
  command: string
}

/** Kebab-case tool id (`[a-z0-9]+(-[a-z0-9]+)*`). */
export function isCustomToolId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** Kebab-case parameter name (same grammar as the tool id). */
export function isParamName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** The registered tool name for one record id. */
export function toolNameOf(id: string): string {
  return `${CUSTOM_TOOL_PREFIX}${id}`
}

/** The record id behind a registered tool name, or undefined for other tools. */
export function recordIdOf(toolName: string): string | undefined {
  return toolName.startsWith(CUSTOM_TOOL_PREFIX) ? toolName.slice(CUSTOM_TOOL_PREFIX.length) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse one untrusted document entry into a record.
 * @param value - raw `customTools` entry.
 * @returns the record, or the first problem.
 */
export function parseCustomToolRecord(value: unknown): { record?: CustomToolRecord; error?: string } {
  if (!isRecord(value)) return { error: 'entry is not an object' }
  const id = value.id
  if (typeof id !== 'string' || !isCustomToolId(id)) return { error: `invalid id ${JSON.stringify(id)}: expected kebab-case` }
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : id
  if (name.length > MAX_NAME_CHARS) return { error: `name is longer than ${MAX_NAME_CHARS} characters` }
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  if (description === '') return { error: 'description is required' }
  if (description.length > MAX_DESCRIPTION_CHARS) return { error: `description is longer than ${MAX_DESCRIPTION_CHARS} characters` }
  const command = typeof value.command === 'string' ? value.command : ''
  if (command.trim() === '') return { error: 'command is required' }
  if (command.length > MAX_COMMAND_CHARS) return { error: `command is longer than ${MAX_COMMAND_CHARS} characters` }
  const rawParams = value.params
  if (rawParams !== undefined && !Array.isArray(rawParams)) return { error: 'params must be an array' }
  const params: CustomToolParam[] = []
  const seen = new Set<string>()
  for (const raw of rawParams ?? []) {
    if (!isRecord(raw)) return { error: 'each param must be an object' }
    const paramName = raw.name
    if (typeof paramName !== 'string' || !isParamName(paramName)) {
      return { error: `invalid param name ${JSON.stringify(paramName)}: expected kebab-case` }
    }
    if (seen.has(paramName)) return { error: `duplicate param "${paramName}"` }
    seen.add(paramName)
    const type = raw.type
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      return { error: `param "${paramName}" has unsupported type ${JSON.stringify(type)}` }
    }
    params.push({
      name: paramName,
      type,
      required: raw.required === true,
      description: typeof raw.description === 'string' ? raw.description : '',
    })
  }
  if (params.length > MAX_PARAMS) return { error: `more than ${MAX_PARAMS} params` }
  return { record: { id, name, description, params, command } }
}

/** POSIX single-quote one value: the only quoting this renderer emits. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** One parameter value coerced to its declared type, or the failure. */
function coerceParam(param: CustomToolParam, value: unknown): { text?: string; error?: string } {
  if (value === undefined || value === null) {
    if (param.required) return { error: `missing required parameter "${param.name}"` }
    return { text: '' }
  }
  if (param.type === 'string') {
    if (typeof value !== 'string') return { error: `parameter "${param.name}" must be a string` }
    return { text: value }
  }
  if (param.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `parameter "${param.name}" must be a finite number` }
    return { text: String(value) }
  }
  if (typeof value !== 'boolean') return { error: `parameter "${param.name}" must be a boolean` }
  return { text: value ? 'true' : 'false' }
}

/**
 * Render one command template with shell-quoted parameter values.
 * @param record - the tool record.
 * @param args - validated model arguments.
 * @returns the rendered command, or the first problem.
 */
export function renderCommand(record: CustomToolRecord, args: unknown): { command?: string; error?: string } {
  const values = isRecord(args) ? args : {}
  const byName = new Map(record.params.map(param => [param.name, param]))
  const rendered = record.command.replace(/\{\{([a-z0-9-]+)\}\}/g, (_match, name: string) => {
    const param = byName.get(name)
    if (param === undefined) return `\u0000unknown:${name}\u0000`
    const coerced = coerceParam(param, values[name])
    if (coerced.error !== undefined) return `\u0000error:${coerced.error}\u0000`
    return shellQuote(coerced.text ?? '')
  })
  const unknown = rendered.match(/\u0000unknown:([a-z0-9-]+)\u0000/)
  if (unknown !== null) return { error: `command references unknown parameter "${unknown[1]}"` }
  const failed = rendered.match(/\u0000error:(.+?)\u0000/)
  if (failed !== null) return { error: failed[1] }
  if (rendered.includes('{{')) return { error: 'command contains a malformed placeholder' }
  return { command: rendered }
}

/** Stable fingerprint of one record, for hot-update diffing. */
export function recordFingerprint(record: CustomToolRecord): string {
  return JSON.stringify(record)
}
