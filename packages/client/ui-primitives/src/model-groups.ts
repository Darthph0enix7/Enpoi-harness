/**
 * Model groups (`enpoi-orchestration.chains`) as every client surface reads
 * them. The settings row stays authoritative; clients never parse the raw
 * `chains` map — they parse the host's resolved-group projection
 * (`modelChains.resolved`, published through the settings artifact channel),
 * which carries the explicit links, the selector expansion, the resolved
 * members, candidates, warnings, and the retire switch.
 *
 * One parser keeps every surface on the same vocabulary: a link's effort is
 * adapter-owned, so a non-string or blank value is absent (the link keeps
 * inheriting) and a valid one is trimmed before any surface sees it. A group
 * with no explicit links but a selector is a valid, selectable group — its
 * members come from the selector expansion.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives/model-groups
 */

/** One ordered link of a group: a route plus the model it serves. */
export interface ModelGroupLink {
  provider: string
  model: string
  effort?: string
}

/** One group selector as the settings row declares it (raw predicate clauses). */
export interface ModelGroupSelector {
  when: Record<string, unknown>
  adopt: boolean
  label?: string
}

/** One selector's expansion, as the resolved-group artifact carries it. */
export interface ModelGroupSelectorMatch {
  /** Selector position in the stored `selectors` array (0-based). */
  index: number
  /** The stored predicate clauses (raw, for display). */
  when: Record<string, unknown>
  adopt: boolean
  label?: string
  /** Every link the selector matched against the live catalogue. */
  links: readonly ModelGroupLink[]
  /** Expansion warnings for this selector alone. */
  warnings: readonly string[]
}

/**
 * One model group as the picker, the editor, and the seat rows read it:
 * the stored fields plus the resolved projection the host publishes.
 */
export interface ModelGroup {
  readonly id: string
  readonly label: string
  /** Explicit links declared on the settings row (adopted first). */
  readonly links: readonly ModelGroupLink[]
  /** Selectors declared on the settings row. */
  readonly selectors: readonly ModelGroupSelector[]
  /** Per-selector expansion, in declaration order. */
  readonly selectorMatches: readonly ModelGroupSelectorMatch[]
  /** Resolved members: explicit links plus adopted selector matches, deduped. */
  readonly members: readonly ModelGroupLink[]
  /** Selector matches an `adopt: false` selector holds back. */
  readonly candidates: readonly ModelGroupLink[]
  /** Parse and expansion warnings for this group. */
  readonly warnings: readonly string[]
  readonly attempts: number
  readonly onCut: 'failover' | 'continue'
  readonly disabled: boolean
  /**
   * Where the group came from: a settings row the operator owns, or the
   * composition's built-in inventory (read-only; customize it to edit).
   */
  readonly source: 'settings' | 'builtin'
  /**
   * Present on a settings group whose id also names a built-in: the row
   * replaces that built-in, and removing the row restores the shipped
   * definition.
   */
  readonly overridesBuiltin?: boolean
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

/** Parse a link list, dropping malformed entries. */
function parseLinks(raw: unknown): ModelGroupLink[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parseLink).filter((link): link is ModelGroupLink => link !== undefined)
}

/** Parse one stored selector, dropping shapeless predicates. */
function parseSelector(raw: unknown): ModelGroupSelector | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (rec.when === null || typeof rec.when !== 'object' || Array.isArray(rec.when)) return undefined
  if (Object.keys(rec.when).length === 0) return undefined
  return {
    when: rec.when as Record<string, unknown>,
    adopt: rec.adopt === true,
    ...typeof rec.label === 'string' && rec.label.trim() !== '' ? { label: rec.label.trim() } : {},
  }
}

/** Parse the stored selector list, dropping malformed entries. */
function parseSelectors(raw: unknown): ModelGroupSelector[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parseSelector).filter((selector): selector is ModelGroupSelector => selector !== undefined)
}

/** Parse one selector expansion row the artifact carries. */
function parseSelectorMatch(raw: unknown): ModelGroupSelectorMatch | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.index !== 'number' || !Number.isInteger(rec.index) || rec.index < 0) return undefined
  const when = rec.when !== null && typeof rec.when === 'object' && !Array.isArray(rec.when)
    ? rec.when as Record<string, unknown>
    : {}
  return {
    index: rec.index,
    when,
    adopt: rec.adopt === true,
    ...typeof rec.label === 'string' && rec.label !== '' ? { label: rec.label } : {},
    links: parseLinks(rec.links),
    warnings: Array.isArray(rec.warnings) ? rec.warnings.filter((line): line is string => typeof line === 'string') : [],
  }
}

/** Parse one group entry (artifact or stored row) into the shared shape. */
function groupOf(id: string, raw: Record<string, unknown>): ModelGroup {
  const links = parseLinks(raw.links)
  const selectors = parseSelectors(raw.selectors)
  const selectorMatches = Array.isArray(raw.selectorMatches)
    ? raw.selectorMatches
      .map(parseSelectorMatch)
      .filter((match): match is ModelGroupSelectorMatch => match !== undefined)
    : []
  // A stored row carries no resolved projection: its members are its links.
  const members = Array.isArray(raw.members) ? parseLinks(raw.members) : links
  const attempts = typeof raw.attempts === 'number' && Number.isInteger(raw.attempts) && raw.attempts >= 1
    ? raw.attempts
    : 2
  return {
    id,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : id,
    links,
    selectors,
    selectorMatches,
    members,
    candidates: parseLinks(raw.candidates),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((line): line is string => typeof line === 'string') : [],
    attempts,
    onCut: raw.onCut === 'continue' ? 'continue' : 'failover',
    disabled: raw.disabled === true,
    source: raw.source === 'builtin' ? 'builtin' : 'settings',
    ...raw.overridesBuiltin === true ? { overridesBuiltin: true } : {},
  }
}

/**
 * Parse one resolved group entry (a `modelChains.resolved` value); undefined
 * when the entry names no usable id.
 * @param id - the group id.
 * @param raw - the resolved entry.
 * @returns the parsed group, or undefined when malformed.
 */
export function parseModelGroup(id: string, raw: unknown): ModelGroup | undefined {
  if (id === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return groupOf(id, raw as Record<string, unknown>)
}

/**
 * Parse one resolved group; undefined when the entry carries no usable id.
 * @param raw - the resolved group object (carries its own `id`).
 * @returns the parsed group, or undefined when malformed.
 */
export function parseResolvedModelGroup(raw: unknown): ModelGroup | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id === '') return undefined
  return groupOf(rec.id, rec)
}

/**
 * Parse the published resolved-group map (`modelChains.resolved`) in stored order.
 * @param value - the artifact value (group id → resolved group).
 * @returns the parsed groups.
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

/**
 * Parse the picker's localStorage mirror (an array of resolved groups).
 * @param value - the mirrored value.
 * @returns the parsed groups.
 */
export function parseModelGroupList(value: unknown): ModelGroup[] {
  if (!Array.isArray(value)) return []
  return value.map(parseResolvedModelGroup).filter((group): group is ModelGroup => group !== undefined)
}
