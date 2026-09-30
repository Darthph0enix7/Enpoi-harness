/**
 * Manual preset authoring client — the profile's fenced `/sidebar/presets`
 * routes (create/edit/delete over the harness config editor). Every failure is
 * a {@link AuthoringApiError} carrying the host's code and message.
 */

/** One authoring row as the host reports it. */
export interface AuthoringPresetRow {
  id: string
  rowId: string
  name: string
  description: string
  order?: number
  builtIn: boolean
  disabled: boolean
  hasPersona: boolean
  suffixChars: number
}

/** One preset with its editable persona suffix. */
export interface AuthoringPresetDetail extends AuthoringPresetRow {
  suffix: string
}

/** Create request body. */
export interface AuthoringCreateInput {
  base: string
  id: string
  name: string
  description: string
  suffix: string
}

/** Update request body. */
export interface AuthoringUpdateInput {
  id: string
  name: string
  description: string
  suffix: string
}

/** One rejected authoring call. */
export class AuthoringApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AuthoringApiError'
  }
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`/sidebar/presets/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new AuthoringApiError('network', error instanceof Error ? error.message : String(error), 0)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new AuthoringApiError('malformed', `“${method}” returned a non-JSON response`, response.status)
  }
  const envelope = parsed as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } | null
  if (envelope?.ok === true) return envelope.value
  const reason: string = typeof envelope?.error?.message === 'string' && envelope.error.message !== ''
    ? envelope.error.message
    : method
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'error'
  throw new AuthoringApiError(code, reason, response.status)
}

/** One row from an untrusted wire value, or undefined when unusable. */
function parseRow(value: unknown): AuthoringPresetRow | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return undefined
  return {
    id: record.id,
    rowId: typeof record.rowId === 'string' ? record.rowId : `preset-${record.id}`,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : record.id,
    description: typeof record.description === 'string' ? record.description : '',
    ...typeof record.order === 'number' ? { order: record.order } : {},
    builtIn: record.builtIn === true,
    disabled: record.disabled === true,
    hasPersona: record.hasPersona === true,
    suffixChars: typeof record.suffixChars === 'number' ? record.suffixChars : 0,
  }
}

/** List the declared presets with authoring metadata. */
export async function listAuthoringPresets(): Promise<AuthoringPresetRow[]> {
  const value = await call('presets.list', {})
  const record = value as { presets?: unknown } | null
  if (record === null || typeof record !== 'object' || !Array.isArray(record.presets)) {
    throw new AuthoringApiError('malformed', '“presets.list” returned a malformed response', 200)
  }
  return record.presets.map(parseRow).filter((row): row is AuthoringPresetRow => row !== undefined)
}

/** Read one preset's editable fields, persona suffix included. */
export async function getAuthoringPreset(id: string): Promise<AuthoringPresetDetail> {
  const value = await call('presets.get', { id })
  const row = parseRow(value)
  if (row === undefined) throw new AuthoringApiError('malformed', '“presets.get” returned a malformed response', 200)
  const suffix = (value as { suffix?: unknown }).suffix
  return { ...row, suffix: typeof suffix === 'string' ? suffix : '' }
}

/** Clone a base preset into a new user preset. */
export async function createAuthoringPreset(input: AuthoringCreateInput): Promise<void> {
  await call('presets.create', { ...input })
}

/** Edit name, description, and persona suffix of a user preset. */
export async function updateAuthoringPreset(input: AuthoringUpdateInput): Promise<void> {
  await call('presets.update', { ...input })
}

/** Delete a user preset row. */
export async function deleteAuthoringPreset(id: string): Promise<void> {
  await call('presets.delete', { id })
}
