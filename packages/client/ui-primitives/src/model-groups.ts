/**
 * Model groups (`enpoi-orchestration.chains`) parse, shared by the picker
 * registry and the Providers editor. One parser keeps both surfaces on the
 * same stored vocabulary: a link's effort is adapter-owned, so a non-string or
 * blank value is absent (the link keeps inheriting) and a valid one is trimmed
 * before either surface sees it.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives/model-groups
 */

/** One ordered link of a group: a route plus the model it serves. */
export interface ModelGroupLink {
  provider: string
  model: string
  effort?: string
}

/** One model group as both surfaces read it (`chains.<id>`). */
export interface ModelGroup {
  readonly id: string
  readonly label: string
  readonly links: readonly ModelGroupLink[]
  readonly attempts: number
  readonly onCut: 'failover' | 'continue'
  readonly disabled: boolean
}

/** Parse one stored link; a link without a route/model is dropped. */
function parseLink(raw: unknown): ModelGroupLink | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== 'string' || rec.provider === '') return undefined
  if (typeof rec.model !== 'string' || rec.model === '') return undefined
  // The effort is adapter-owned: a non-string or blank value is absent, so the
  // link keeps inheriting exactly as a link that never declared one.
  const effort = typeof rec.effort === 'string' ? rec.effort.trim() : ''
  return {
    provider: rec.provider,
    model: rec.model,
    ...effort === '' ? {} : { effort },
  }
}

/**
 * Parse one stored group; undefined when the entry names no usable id.
 * @param id - the `chains.<id>` key.
 * @param raw - the stored group value.
 * @returns the parsed group, or undefined when malformed.
 */
export function parseModelGroup(id: string, raw: unknown): ModelGroup | undefined {
  if (id === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const links = Array.isArray(rec.links)
    ? rec.links.map(parseLink).filter((link): link is ModelGroupLink => link !== undefined)
    : []
  const attempts = typeof rec.attempts === 'number' && Number.isInteger(rec.attempts) && rec.attempts >= 1
    ? rec.attempts
    : 2
  return {
    id,
    label: typeof rec.label === 'string' && rec.label !== '' ? rec.label : id,
    links,
    attempts,
    onCut: rec.onCut === 'continue' ? 'continue' : 'failover',
    disabled: rec.disabled === true,
  }
}

/**
 * Parse the stored `chains` map into registry order, dropping malformed entries.
 * @param value - the stored `chains` value.
 * @returns the parsed groups in stored order.
 */
export function parseModelGroups(value: unknown): ModelGroup[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const groups: ModelGroup[] = []
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const group = parseModelGroup(id, raw)
    if (group !== undefined) groups.push(group)
  }
  return groups
}
