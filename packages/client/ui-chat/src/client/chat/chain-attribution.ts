/**
 * Model-group attribution for completed turns.
 *
 * The producing selection carries an optional group id (`chain`); the group's
 * label and its ordered links live in the settings registry, mirrored into
 * localStorage by ui-model-selection (`dsh_model_groups_v1`). The badge reads
 * that mirror synchronously — the chat package must not open a second settings
 * connection — and falls back to the plain model when the id is unknown
 * (dangling group: removed or renamed while a session still references it).
 */

/** One mirrored link, as much as the badge needs. */
interface MirroredLink {
  model?: unknown
}

/** Chain + answering model as the badge prints them. */
export interface ChainAttribution {
  /** The group id exactly as the selection carried it. */
  chain: string
  /** The badge text: `Stable (gemini-3.8-flash)` or `Stable → mimo-v2.5`. */
  badge: string
}

type Registry = Map<string, { label: string; firstModel: string | undefined }>

let cachedRaw: string | null = null
let cachedRegistry: Registry = new Map()

/** Read the group mirror, reparsing only when its raw text changed. */
function registry(): Registry {
  try {
    const raw = localStorage.getItem('dsh_model_groups_v1')
    if (raw === cachedRaw) return cachedRegistry
    cachedRaw = raw
    const next: Registry = new Map()
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const group = entry as { id?: unknown; label?: unknown; links?: unknown }
          if (typeof group.id !== 'string' || group.id === '') continue
          const links = Array.isArray(group.links) ? group.links as MirroredLink[] : []
          const firstModel = links
            .map(link => link.model)
            .find((model): model is string => typeof model === 'string' && model !== '')
          next.set(group.id, {
            label: typeof group.label === 'string' && group.label !== '' ? group.label : group.id,
            firstModel,
          })
        }
      }
    }
    cachedRegistry = next
    return next
  } catch {
    return cachedRegistry
  }
}

/**
 * Read the optional group id off a durable provenance/request-config record.
 * @param record - the record carrying `chain` when the producing selection had one.
 * @returns the group id, or undefined when absent/non-string.
 */
export function chainOfRecord(record: object | undefined): string | undefined {
  const chain = record === undefined ? undefined : (record as { chain?: unknown }).chain
  return typeof chain === 'string' && chain !== '' ? chain : undefined
}

/**
 * Compose the badge for a turn produced under a group.
 * @param chain - the group id carried by the producing selection.
 * @param model - the answering model id (durable provenance / finish chunk).
 * @returns the attribution, or undefined when the model is unknown.
 */
export function chainAttribution(chain: string | undefined, model: string | undefined): ChainAttribution | undefined {
  if (chain === undefined || model === undefined || model === '') return undefined
  const group = registry().get(chain)
  const label = group?.label ?? chain
  const badge = group?.firstModel !== undefined && group.firstModel !== model
    ? `${label} → ${model}`
    : `${label} (${model})`
  return { chain, badge }
}
