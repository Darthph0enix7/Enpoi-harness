/**
 * enpoi-capabilities — prompt-surface honesty (the delegate that burned four
 * calls on `job_output`).
 *
 * The tool plugins register their usage guidance as static system-prompt
 * sections (`tool:jobs`, `tool:goal`, `tool:session-query`, …). The
 * `system-prompt/assemble` listener in `index.ts` already narrows the wire tool
 * list per scope (B1b capability strip, then delegated-child advertisement
 * honesty), but the section TEXT stayed untouched — so a council debater was
 * told to `job_output`/`session_search`/`create_goal` even though none of those
 * tools was on its advertised surface, then burned calls and a reasoning cycle.
 *
 * This module keeps those two halves in lockstep: a section may only name a
 * tool the surface actually advertises. The filter runs on the assembled
 * sections with the FINAL advertised set, so it covers every current and future
 * tool plugin without each one re-implementing the check (the fs plugins'
 * own `({ scope }) => ctx.tools.get(...) === undefined ? '' : …` gating stays
 * as the first line of defence).
 *
 * @module dsh-enpoi-capabilities/prompt-honesty
 */

/** One section as the assembly waterfall sees it (structural, never the live type). */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly interpolate?: boolean
}

/** Escape one literal string for inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether one paragraph names a tool. Distinctive snake_case names count on any
 * word-boundary occurrence; names that are ordinary English words (`read`,
 * `edit`, `bash`, `present`) count only when quoted or used in tool position
 * ("the read tool", "use edit", "call present") so prose like "read the file"
 * is never mistaken for a tool mention.
 * @param text - one paragraph of section text.
 * @param name - one registry tool name.
 * @returns true when the paragraph names the tool.
 */
export function mentionsTool(text: string, name: string): boolean {
  if (name.length === 0) return false
  const escaped = escapeRegExp(name)
  if (name.includes('_')) return new RegExp(`(?<![\\w])${escaped}(?![\\w])`).test(text)
  return new RegExp(
    `\`${escaped}\``
    + `|\\btools?\\s+${escaped}\\b`
    + `|\\b${escaped}\\s+(?:tools?|calls?)\\b`
    + `|\\b(?:use|uses|using|call|calls|calling|invoke|invokes|with)\\s+\`?${escaped}\`?\\b`,
  ).test(text)
}

/**
 * Drop every prompt paragraph that names a known tool the surface does not
 * advertise, and every `tool:<name>` guidance section whose own tool is not
 * advertised. Paragraph granularity keeps the honest half of a section that
 * names both an available and an unavailable tool. A section whose text no
 * longer carries anything is dropped entirely; an assembly with nothing
 * unavailable is returned unchanged.
 * @param sections - the assembled sections (uninterpolated text).
 * @param advertised - tool names the final model-facing surface carries.
 * @param vocabulary - every tool name the registry knows (the mention dictionary).
 * @returns the retained sections (a new array only when something changed).
 */
export function stripUnavailableToolGuidance<T extends PromptSectionLike>(
  sections: readonly T[],
  advertised: ReadonlySet<string>,
  vocabulary: ReadonlySet<string>,
): T[] {
  const unavailable = [...vocabulary].filter(name => name.length > 0 && !advertised.has(name))
  if (unavailable.length === 0) return [...sections]
  const keptSections: T[] = []
  for (const section of sections) {
    const own = section.name.startsWith('tool:') ? section.name.slice('tool:'.length) : undefined
    if (own !== undefined && vocabulary.has(own) && !advertised.has(own)) continue
    const paragraphs = section.text.split(/\n\s*\n/)
    const keptParagraphs = paragraphs.filter(paragraph => !unavailable.some(name => mentionsTool(paragraph, name)))
    if (keptParagraphs.length === paragraphs.length) {
      keptSections.push(section)
      continue
    }
    const text = keptParagraphs.join('\n\n')
    if (text.trim() === '') continue
    keptSections.push({ ...section, text })
  }
  return keptSections
}
