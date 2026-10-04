/**
 * Skill-catalog negotiation for disabled capabilities.
 *
 * The catalog listener appends a user message whose text carries the
 * `<available_skills>` block and whose source records the published entries.
 * Disabled skills are removed from both, and a catalog update that adds no
 * enabled skill is dropped instead of re-injecting the same block.
 *
 * @module dsh-enpoi-capabilities/catalog
 */

interface CatalogMessage {
  readonly source?: unknown
  readonly content?: unknown
}

interface CatalogEntry {
  readonly name?: unknown
}

/** Outcome of one pre-step catalog pass. */
export interface CatalogFilterResult {
  /** Model-facing messages after disabled entries were removed. */
  readonly messages: readonly CatalogMessage[]
  /** How many catalog updates were dropped as no-ops. */
  readonly droppedUpdates: number
}

/**
 * Strip disabled skills from one skill-catalog message.
 * @param msg - candidate message from the pre-step decision.
 * @param disabledSkillIds - skill ids disabled by operator settings.
 * @returns the rewritten message, or undefined when it is not a catalog message.
 */
function rewriteCatalogMessage(msg: CatalogMessage, disabledSkillIds: ReadonlySet<string>): CatalogMessage | undefined {
  const source = msg.source as { kind?: string; entries?: unknown } | undefined
  if (source?.kind !== 'skill-catalog') return undefined
  const content = msg.content
  if (!Array.isArray(content)) return msg
  const newContent = content.map((block: { type?: string; text?: string }) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const kept = block.text.split('\n').filter(line => {
      const m = line.match(/^- `([^`]+)`:/)
      if (!m) return true
      return !disabledSkillIds.has(m[1])
    })
    return { ...block, text: kept.join('\n') }
  })
  const entries = Array.isArray(source.entries)
    ? source.entries.filter(entry => !(entry !== null && typeof entry === 'object'
      && typeof (entry as CatalogEntry).name === 'string'
      && disabledSkillIds.has((entry as { name: string }).name)))
    : source.entries
  return {
    ...msg,
    content: newContent,
    source: { ...source, ...(entries === undefined ? {} : { entries }) },
  }
}

/** Entry names of a rewritten message, used to detect a no-op update. */
function catalogNames(msg: CatalogMessage): string {
  const entries = (msg.source as { entries?: unknown } | undefined)?.entries
  return Array.isArray(entries)
    ? entries.map(entry => String((entry as CatalogEntry).name ?? '')).join('\u0000')
    : ''
}

/**
 * Apply the disabled-skill filter to one pre-step decision's messages.
 * @param messages - model-facing messages of the decision.
 * @param disabledSkillIds - skill ids disabled by operator settings.
 * @param published - per-session last published catalog names (mutated).
 * @param sessionId - owning session id, or '' when unknown.
 * @returns filtered messages and the dropped-update count.
 */
export function filterSkillCatalogMessages(
  messages: readonly CatalogMessage[],
  disabledSkillIds: ReadonlySet<string>,
  published: Map<string, string>,
  sessionId: string,
): CatalogFilterResult {
  const filtered: CatalogMessage[] = []
  let droppedUpdates = 0
  for (const msg of messages) {
    const rewritten = rewriteCatalogMessage(msg, disabledSkillIds)
    if (rewritten === undefined) { filtered.push(msg); continue }
    const names = catalogNames(rewritten)
    const isUpdate = (msg.source as { update?: unknown } | undefined)?.update === true
    if (isUpdate && sessionId !== '' && published.get(sessionId) === names) {
      droppedUpdates += 1
      continue
    }
    if (sessionId !== '') {
      if (published.size > 500) published.clear()
      published.set(sessionId, names)
    }
    filtered.push(rewritten)
  }
  return { messages: filtered, droppedUpdates }
}
