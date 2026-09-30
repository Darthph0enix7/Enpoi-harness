/**
 * Client-side model for operator-authored command tools
 * (`enpoi-orchestration.customTools`), shared by the Skills & tools panel.
 */

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

/** Kebab-case tool/parameter name. */
export function isCustomToolId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** The registered tool name for one record id. */
export function customToolNameOf(id: string): string {
  return `custom_${id}`
}

/** A fresh parameter row. */
export function emptyParam(): CustomToolParam {
  return { name: '', type: 'string', required: false, description: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse the document's `customTools` array leniently (invalid entries are dropped). */
export function parseCustomTools(value: unknown): CustomToolRecord[] {
  if (!Array.isArray(value)) return []
  const records: CustomToolRecord[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = entry.id
    if (typeof id !== 'string' || !isCustomToolId(id)) continue
    const params: CustomToolParam[] = []
    if (Array.isArray(entry.params)) {
      for (const raw of entry.params) {
        if (!isRecord(raw)) continue
        const name = raw.name
        if (typeof name !== 'string' || !isCustomToolId(name)) continue
        const type = raw.type === 'number' || raw.type === 'boolean' ? raw.type : 'string'
        params.push({ name, type, required: raw.required === true, description: typeof raw.description === 'string' ? raw.description : '' })
      }
    }
    records.push({
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      params,
      command: typeof entry.command === 'string' ? entry.command : '',
    })
  }
  return records
}
