/**
 * Checkpoint draft extraction: one JSON item list, validated by code.
 *
 * The model proposes current-continuity items (operator goals, constraints,
 * stated decisions, observed evidence, unresolved work). It never assigns
 * trust: this module records an exact operator quote only when the words form
 * a complete source block or complete line run in a currently active human
 * operator message at the cited sequence. The quote proves the words, not the
 * interpretation: it is not proof of an accepted decision, and a one-off
 * request is not a standing rule. Assistant/tool anchors remain observed, not
 * verified execution.
 *
 * Invalid JSON, an inactive or wrong-source anchor, a future sequence, or a
 * non-exact quote fails the whole draft. The caller then uses the
 * deterministic neutral template for that refresh; it does not ask the model
 * again and it never publishes partial authority.
 *
 * @module dsh-enpoi-context-keeper/checkpoint-draft
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { operatorQuoteMatches, type ActiveAuthorityView } from './authority.ts'

/** The item vocabulary the checkpoint prompt requests. */
export type CheckpointDraftKind =
  | 'operator_goal'
  | 'operator_constraint'
  | 'accepted_decision'
  | 'observed_evidence'
  | 'unresolved_work'

const DRAFT_KINDS = new Set<string>([
  'operator_goal',
  'operator_constraint',
  'accepted_decision',
  'observed_evidence',
  'unresolved_work',
])

/** One validated item ready for the canonical renderer. */
export interface ValidatedCheckpointItem {
  kind: CheckpointDraftKind
  text: string
  sourceSeq: number
  /** Exact operator quote; evidence of the words, not of their interpretation. */
  quote?: string
  /** Whether the anchor sequence sits before the current input window. */
  outsideWindow: boolean
  /** Event type at the anchor, used for the observed-evidence label. */
  anchorType: string
}

/** Validation output: either every item passed or the draft is discarded. */
export interface CheckpointDraftValidation {
  ok: boolean
  items: ValidatedCheckpointItem[]
  reason?: string
}

/**
 * Lookups the validator needs.
 *
 * `active` is the current-surface authority view. Supply it on every live
 * path: with it, abandoned/reverted events cannot anchor a draft. The legacy
 * callbacks are retained for migration only; they read the raw log and are
 * not surface-safe. A caller that supplies `active` may omit the callbacks.
 */
export interface CheckpointDraftContext {
  /** Snapshot sequence captured before the model call; anchors must precede it. */
  snapshotSeq: number
  /** First sequence in the framed input window. */
  windowStartSeq: number
  /** Current-surface authority view (required for surface-safe validation). */
  active?: ActiveAuthorityView
  /** Legacy exact operator lookup; ignored when `active` is supplied. */
  operatorPartsAt?: (seq: number) => readonly string[] | null
  /** Legacy event lookup; ignored when `active` is supplied. */
  eventAt?: (seq: number) => SessionEvent | undefined
}

/**
 * Current-continuity extraction prompt. It asks for public decision
 * explanations, not private chain-of-thought, and states the temporal scope
 * rule so a one-off request cannot become a standing directive.
 */
export const CHECKPOINT_DRAFT_PROMPT = [
  'You are the Enpoi Harness context keeper. Produce the CURRENT continuity checkpoint for this session — not a chronological summary.',
  'Report only these current-state categories:',
  '- operator_goal: goals the human operator is currently pursuing.',
  '- operator_constraint: explicit constraints, scope limits, or prohibitions the human operator stated.',
  '- accepted_decision: decisions the human operator explicitly stated or accepted.',
  '- observed_evidence: public facts observed in assistant text or tool output.',
  '- unresolved_work: open questions, blockers, or the next concrete step.',
  '',
  'Output EXACTLY one JSON object, no markdown and no commentary:',
  '{"items":[{"kind":"operator_goal","text":"concise current-state statement","quote":"exact operator words","sourceSeq":12}]}',
  '',
  'Rules:',
  '- The model does not decide trust. Code verifies only that the quoted words are present; it cannot verify their interpretation or truth.',
  '- For operator_goal, operator_constraint, and accepted_decision, quote MUST be copied verbatim from ONE human operator message at sourceSeq, as a complete text block or a complete line/run of that block. Never quote a fragment of a line; never join separate messages or blocks. Never quote the assistant, a tool result, a compaction summary, a checkpoint, or injected runtime context.',
  '- An exact quote is evidence of the operator\'s words only. It is not proof of an accepted decision, a permanent rule, or current truth. A one-off request, style preference, question, or request for explanation is not a standing constraint. Preserve the operator\'s original wording and explicit scope; do not rewrite the quote into a new imperative.',
  '- A proposal by the assistant is not an accepted decision.',
  '- For observed_evidence, sourceSeq MUST name a CURRENTLY ACTIVE public assistant message or tool event that contains the observation. Tool output is observed, not proof that an execution succeeded.',
  '- For unresolved_work, sourceSeq MUST name a CURRENTLY ACTIVE public assistant message or tool event that anchors the open item. Do not invent work that no logged event supports.',
  '- Never include private reasoning, hidden chain-of-thought, credentials, passwords, API keys, or tokens.',
  '- Keep each text field a public, concise statement. Preserve legitimate code, JSON field names, and non-English text exactly.',
  '- If nothing is established yet, output {"items":[]}.',
].join('\n')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Extract the first balanced JSON object from model text, ignoring braces
 * inside JSON strings and escapes.
 * @param text - raw model output (possibly fenced).
 * @returns the balanced object source, or null when no complete object exists.
 */
export function extractCheckpointDraftJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/**
 * Parse the model's draft object. No retry and no repair happen here: an
 * unparseable payload returns null and the caller uses the neutral template.
 * @param raw - raw model output.
 * @returns the parsed object, or null when the output is not one JSON object.
 */
export function parseCheckpointDraft(raw: string): Record<string, unknown> | null {
  const json = extractCheckpointDraftJson(raw)
  if (json === null) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function invalid(reason: string): CheckpointDraftValidation {
  return { ok: false, items: [], reason }
}

/** The event types an observed-evidence anchor may name. */
const OBSERVED_EVIDENCE_ANCHORS = new Set(['assistant/message', 'tool/result', 'tool/call'])
/** The event types an unresolved-work anchor may name. */
const UNRESOLVED_ANCHORS = new Set(['assistant/message', 'tool/result', 'tool/call', 'user/message'])

/**
 * Validate a parsed draft against the current surface.
 *
 * All-or-nothing: one inactive, unsupported, or unquoted claim discards the
 * whole draft, so a partial model response can never publish fabricated
 * authority. When `context.active` is supplied, the cited sequence must be a
 * current surface event (or a paired raw tool call, or the newest checkpoint)
 * and operator quotes must be complete blocks/lines from an active human
 * message. Legacy callbacks read the raw log; use them only during migration.
 * @param draft - parsed JSON object from {@link parseCheckpointDraft}.
 * @param context - snapshot, window, and active-surface lookups.
 * @returns validated items, or a failure reason the caller logs before using
 *   the deterministic template.
 */
export function validateCheckpointDraft(
  draft: Record<string, unknown>,
  context: CheckpointDraftContext,
): CheckpointDraftValidation {
  const active = context.active
  const eventAt = active !== undefined ? (seq: number) => active.eventAt(seq) : context.eventAt
  const operatorPartsAt = active !== undefined
    ? (seq: number) => active.operatorPartsAt(seq)
    : context.operatorPartsAt
  if (eventAt === undefined || operatorPartsAt === undefined) {
    return invalid('draft validation has no active surface view or source lookup')
  }
  const rawItems = draft['items']
  if (!Array.isArray(rawItems)) return invalid('draft has no items array')
  const items: ValidatedCheckpointItem[] = []
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw: unknown = rawItems[index]
    if (!isRecord(raw)) return invalid(`item ${index} is not an object`)
    const kind = raw['kind']
    if (typeof kind !== 'string' || !DRAFT_KINDS.has(kind)) return invalid(`item ${index} has an unknown kind`)
    const text = raw['text']
    if (typeof text !== 'string' || text.trim().length === 0) return invalid(`item ${index} has no text`)
    const sourceSeq = raw['sourceSeq']
    if (typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0) {
      return invalid(`item ${index} has no valid sourceSeq`)
    }
    if (sourceSeq >= context.snapshotSeq) {
      return invalid(`item ${index} cites a future sequence (${sourceSeq} >= ${context.snapshotSeq})`)
    }
    const event = eventAt(sourceSeq)
    if (event === undefined) {
      return invalid(`item ${index} cites an inactive or unlogged sequence ${sourceSeq}`)
    }
    const outsideWindow = sourceSeq < context.windowStartSeq
    const anchorType = event.type
    if (kind === 'operator_goal' || kind === 'operator_constraint' || kind === 'accepted_decision') {
      const parts = operatorPartsAt(sourceSeq)
      if (parts === null) {
        return invalid(`item ${index} claims operator authority from a non-operator or inactive source at seq ${sourceSeq}`)
      }
      const quote = raw['quote']
      if (typeof quote !== 'string' || !operatorQuoteMatches(parts, quote)) {
        return invalid(`item ${index} operator quote is not a complete verbatim block or line at seq ${sourceSeq}`)
      }
      items.push({
        kind,
        text: text.trim(),
        sourceSeq,
        quote,
        outsideWindow,
        anchorType,
      })
      continue
    }
    if (kind === 'observed_evidence') {
      if (!OBSERVED_EVIDENCE_ANCHORS.has(anchorType)) {
        return invalid(`item ${index} observed evidence anchors to ${anchorType}, not public assistant/tool output`)
      }
      items.push({ kind, text: text.trim(), sourceSeq, outsideWindow, anchorType })
      continue
    }
    if (kind === 'unresolved_work') {
      if (!UNRESOLVED_ANCHORS.has(anchorType)) {
        return invalid(`item ${index} unresolved work anchors to ${anchorType}`)
      }
      if (anchorType === 'user/message' && operatorPartsAt(sourceSeq) === null) {
        return invalid(`item ${index} unresolved work cites a non-operator or inactive user message as evidence`)
      }
      items.push({ kind, text: text.trim(), sourceSeq, outsideWindow, anchorType })
      continue
    }
    return invalid(`item ${index} has an unsupported kind`)
  }
  return { ok: true, items }
}

/** Human label for one observed anchor. */
function observedLabel(item: ValidatedCheckpointItem): string {
  switch (item.anchorType) {
    case 'assistant/message':
      return 'public assistant text'
    case 'tool/result':
      return 'tool result observed; execution not verified'
    case 'tool/call':
      return 'tool request observed'
    default:
      return 'operator message observed; not authority'
  }
}

/**
 * Clip text to a UTF-16 hard bound without splitting a surrogate pair.
 *
 * The optional suffix is reserved inside the bound; the returned length never
 * exceeds the numeric cap. A cap too small for the suffix returns the clipped
 * prefix without it (possibly empty). The caller reserves any caption/footer
 * on the final emitted block; this helper only bounds the text it is given.
 * @param text - text to clip.
 * @param maxChars - maximum UTF-16 code units; non-finite means unclipped.
 * @param suffix - optional marker reserved inside the bound, e.g. `…`.
 * @returns text no longer than `maxChars`, cut on a code-point boundary.
 */
export function clipUnicodeSafe(text: string, maxChars: number, suffix = ''): string {
  if (!Number.isFinite(maxChars)) return text
  const cap = Math.max(0, Math.floor(maxChars))
  if (text.length <= cap) return text
  if (cap === 0) return ''
  const safeSuffix = suffix.length <= cap ? suffix : ''
  const target = cap - safeSuffix.length
  let end = 0
  for (const char of text) {
    if (end + char.length > target) break
    end += char.length
  }
  return `${text.slice(0, end)}${safeSuffix}`
}

/** Collapse model-authored line breaks so one item cannot forge another row. */
function singleLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/** Display a quote on one line while preserving its words; validation uses raw blocks. */
function quoteForDisplay(quote: string): string {
  return quote.replace(/\r\n?|\n/g, '\\n')
}

/**
 * Canonical renderer. Its output is stored only in the existing
 * `CheckpointData.text` field; no event or schema field is added.
 *
 * When the complete draft exceeds the bound, whole trailing items are omitted
 * (observed evidence first, then later groups) rather than cutting an item
 * mid-line: a kept item always carries its complete source sequence and quote.
 * If no complete
 * item fits, the renderer returns '' so the caller can use the deterministic
 * template directly. The bound covers this renderer's own header/window/item
 * text; the caller reserves the surface caption and telemetry footer.
 * @param items - validated draft items.
 * @param options - output bound and window facts for the explicit gap note.
 * @returns the current-continuity checkpoint text, bounded to `maxChars`, or
 *   '' when no complete item fits.
 */
export function renderCheckpointDraft(
  items: readonly ValidatedCheckpointItem[],
  options: { maxChars: number; windowStartSeq: number },
): string {
  const groups: Array<{ kind: CheckpointDraftKind; header: string }> = [
    { kind: 'operator_goal', header: '🎯 OPERATOR GOALS (exact operator quote; interpretation unconfirmed):' },
    { kind: 'operator_constraint', header: '🛑 OPERATOR CONSTRAINTS & SCOPE (exact operator quote; interpretation unconfirmed; a one-off request is not a standing rule):' },
    { kind: 'accepted_decision', header: '✅ OPERATOR QUOTE (interpretation unconfirmed; not proof of an accepted decision; a one-off request is not a standing rule):' },
    { kind: 'unresolved_work', header: '⚡ OPEN WORK & NEXT STEP (anchored observation):' },
    { kind: 'observed_evidence', header: '👁 OBSERVED EVIDENCE (public text/tool output; not verified execution):' },
  ]
  const cap = Number.isFinite(options.maxChars) ? Math.max(1, Math.floor(options.maxChars)) : 2400
  if (items.length === 0) return ''
  const windowLine = options.windowStartSeq > 0
    ? `_Input window starts at seq ${options.windowStartSeq}; earlier anchors are re-checked only where cited._`
    : ''
  const entries: Array<{ kind: CheckpointDraftKind; line: string }> = []
  for (const group of groups) {
    for (const item of items) {
      if (item.kind !== group.kind) continue
      const anchor = item.outsideWindow
        ? `; outside the current input window, re-checked at seq ${item.sourceSeq}`
        : ''
      const line = item.quote !== undefined
        ? `- ${singleLine(item.text)} — operator quote (interpretation unconfirmed), seq ${item.sourceSeq}: "${quoteForDisplay(item.quote)}"${anchor}`
        : `- ${singleLine(item.text)} — ${observedLabel(item)} seq ${item.sourceSeq}${anchor}`
      entries.push({ kind: item.kind, line })
    }
  }
  const renderPrefix = (count: number, includeWindow: boolean, suffix: string): string => {
    const retained = entries.slice(0, count)
    const sections: string[] = []
    if (includeWindow && windowLine.length > 0) sections.push(windowLine)
    for (const group of groups) {
      const lines = retained.filter((entry) => entry.kind === group.kind).map((entry) => entry.line)
      if (lines.length === 0) continue
      sections.push([group.header, ...lines].join('\n'))
    }
    const body = sections.join('\n\n')
    if (body.length === 0) return suffix.replace(/^\n/, '')
    return `${body}${suffix}`
  }

  const withWindow = renderPrefix(entries.length, true, '')
  if (withWindow.length <= cap) return withWindow
  for (let count = entries.length; count >= 1; count -= 1) {
    const omitted = entries.length - count
    const markers = omitted === 0
      ? ['']
      : [`\n… [${omitted} item${omitted === 1 ? '' : 's'} omitted]`, '\n…']
    for (const includeWindow of [false, true]) {
      for (const marker of markers) {
        const text = renderPrefix(count, includeWindow, marker)
        if (text.length <= cap) return text
      }
    }
  }
  return ''
}
