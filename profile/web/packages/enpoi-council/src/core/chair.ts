/**
 * Chair deliverable validation — the output-shape gate (2026-09-27).
 *
 * The Chair compiles a structured document with EXACTLY the spec's
 * `deliverableSections`. Operator-observed failure: a timed-out chair was
 * respawned, the second chair returned a stub-shaped document, and the engine
 * forwarded it as a successful deliverable with no validation anywhere. A
 * missing or bodyless section is a REPORTED failure (retry, then mechanical
 * compilation), never an empty answer forwarded.
 */

/** A chair turn that does not satisfy the required deliverable sections. */
export class ChairOutputError extends Error {
  /** The required sections that were absent or had no body text. */
  readonly missing: string[]
  constructor(missing: string[], excerpt: string) {
    super(`chair deliverable invalid — missing or empty required section(s): ${missing.join(', ')}${excerpt ? ` (got: "${excerpt}")` : ''}`)
    this.name = 'ChairOutputError'
    this.missing = missing
  }
}

export interface ChairValidation {
  ok: boolean
  /** Required sections that are absent or have no body text. */
  missing: string[]
}

/**
 * Normalize one line to a section-heading key: strip list markers, markdown
 * heading hashes, bold/italic markers, and a trailing colon. `## Decision`,
 * `**Decision:**` and `Decision:` all normalize to `decision`.
 */
function headingKey(line: string): string {
  return line
    .trim()
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)*/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^[_*]+|[_*]+$/g, '')
    .replace(/\s*[:\u2014-]\s*$/, '')
    .trim()
    .toLowerCase()
}

/** Whether a line opens a new markdown heading block. */
function isHeadingLine(line: string): boolean {
  return /^\s*(?:#{1,6}\s+|[-*+]\s+\*\*|\*\*)/.test(line) || /^\s*[A-Z][^.!?]*:\s*$/.test(line)
}

/**
 * Validate a chair deliverable against the spec's required sections: every
 * section must appear as a heading and carry body text beyond the heading.
 * @param text - the chair turn's extracted text.
 * @param sections - `spec.deliverableSections`.
 * @returns whether the deliverable satisfies the shape, and which sections are missing/empty.
 */
export function validateChairDeliverable(text: string, sections: readonly string[]): ChairValidation {
  const trimmed = text.trim()
  if (sections.length === 0) return { ok: trimmed.length > 0, missing: [] }
  const lines = trimmed.split(/\r?\n/)
  const missing: string[] = []
  for (const section of sections) {
    const key = headingKey(section)
    let foundAt = -1
    for (let i = 0; i < lines.length; i++) {
      if (headingKey(lines[i]) === key) {
        foundAt = i
        break
      }
    }
    if (foundAt === -1) {
      missing.push(section)
      continue
    }
    let body = ''
    for (let i = foundAt + 1; i < lines.length; i++) {
      if (isHeadingLine(lines[i])) break
      body += `${lines[i]}\n`
    }
    if (!/[A-Za-z0-9]{2,}/.test(body)) missing.push(section)
  }
  return { ok: missing.length === 0, missing }
}
